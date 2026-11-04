import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict

from chair_agent.pieces import PieceHit

DEFAULT_BASE_URL = "https://api.meta.ai/v1"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
_TIMEOUT_SECONDS = 120.0

RoleName = Literal["planner", "executor", "verifier"]


class RoleModels(BaseModel):
    model_config = ConfigDict(extra="forbid")

    planner: str | None
    executor: str | None
    verifier: str | None


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["developer", "user", "assistant"]
    # Plain text, or OpenAI-style content parts (text/image_url) so vision
    # calls (effect briefs, render checks) can attach images. model_dump
    # passes both shapes through to the chat API unchanged.
    content: str | list[dict[str, Any]]


class Completion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    text: str


class ModelNotConfigured(Exception):
    def __init__(self, role: str) -> None:
        self.role = role
        super().__init__(f"{role} model is not configured")


class UnexpectedResponse(Exception):
    pass


class Transport(Protocol):
    def post_json(self, path: str, body: dict[str, Any], api_key: str | None) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Settings:
    models: RoleModels
    base_url: str
    api_key: str | None


_MEMORY_KEYS: dict[str, str] = {}


def set_key(provider: str, key: str | None) -> None:
    norm = provider.strip().lower()
    if key and key.strip():
        _MEMORY_KEYS[norm] = key.strip()
    else:
        _MEMORY_KEYS.pop(norm, None)


def get_key(provider: str = "meta", env: Mapping[str, str] | None = None) -> str | None:
    norm = provider.strip().lower()
    if norm in _MEMORY_KEYS:
        return _MEMORY_KEYS[norm]
    source: Mapping[str, str] = os.environ if env is None else env
    env_vars = {
        "meta": "META_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    return _value(source, env_vars.get(norm, f"{norm.upper()}_API_KEY"))


def _value(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(key, "").strip()
    return value or None


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    source: Mapping[str, str] = os.environ if env is None else env
    base_url = _value(source, "META_API_BASE_URL") or DEFAULT_BASE_URL
    return Settings(
        models=RoleModels(
            planner=_value(source, "CHAIR_PLANNER_MODEL"),
            executor=_value(source, "CHAIR_EXECUTOR_MODEL"),
            verifier=_value(source, "CHAIR_VERIFIER_MODEL"),
        ),
        base_url=base_url.rstrip("/"),
        api_key=get_key("meta", env=env),
    )


def configured_models(env: Mapping[str, str] | None = None) -> dict[str, str | None]:
    return load_settings(env).models.model_dump()


def key_configured(provider: str = "meta", env: Mapping[str, str] | None = None) -> bool:
    """Whether the agent sees a key for the provider in memory or environment."""
    return get_key(provider, env=env) is not None


def keys_configured(env: Mapping[str, str] | None = None) -> dict[str, bool]:
    """Key presence per known provider, never the key values."""
    return {
        "meta": key_configured("meta", env=env),
        "openai": key_configured("openai", env=env),
        "anthropic": key_configured("anthropic", env=env),
    }


class HttpxTransport:
    def __init__(self, base_url: str, *, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client if client is not None else httpx.Client(timeout=_TIMEOUT_SECONDS)

    def post_json(self, path: str, body: dict[str, Any], api_key: str | None) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        response = self._client.post(f"{self.base_url}{path}", json=body, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise UnexpectedResponse
        return payload


def completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise UnexpectedResponse
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise UnexpectedResponse
    content = message.get("content")
    if not isinstance(content, str):
        raise UnexpectedResponse
    return content


class ModelClient:
    def __init__(self, *, models: RoleModels, transport: Transport, api_key: str | None) -> None:
        self.models = models
        self.transport = transport
        self._api_key = api_key

    def plan(self, messages: Sequence[Message]) -> Completion:
        return self.complete("planner", messages)

    def execute(self, messages: Sequence[Message]) -> Completion:
        return self.complete("executor", messages)

    def verify(self, messages: Sequence[Message]) -> Completion:
        return self.complete("verifier", messages)

    def complete_model(self, model: str, messages: Sequence[Message]) -> Completion:
        """One call with an explicit model name, bypassing the role map.

        Lets a subagent pick Spark or Wonder per task without rewiring roles.
        """
        if not isinstance(model, str) or not model.strip():
            raise ValueError("model must be a non-empty string")
        payload = self.transport.post_json(
            "/chat/completions",
            {
                "model": model,
                "messages": [message.model_dump(mode="json") for message in messages],
            },
            self._api_key,
        )
        return Completion(model=model, text=completion_text(payload))

    def complete(self, role: RoleName, messages: Sequence[Message]) -> Completion:
        model = self._model_name(role)
        payload = self.transport.post_json(
            "/chat/completions",
            {
                "model": model,
                "messages": [message.model_dump(mode="json") for message in messages],
            },
            self._api_key,
        )
        return Completion(model=model, text=completion_text(payload))

    def _model_name(self, role: RoleName) -> str:
        name = getattr(self.models, role)
        if not isinstance(name, str) or not name:
            raise ModelNotConfigured(role)
        return name


def build_planner_messages(instruction: str, hits: Sequence[PieceHit]) -> list[Message]:
    """Planner prompt carrying the catalog search: pieces, refs, and defaults."""
    if not instruction.strip():
        raise ValueError("instruction must be a non-empty string")
    lines = ["Candidate pieces (id [effect via endpoint]; needs refs; defaults):"]
    for hit in hits:
        refs = ", ".join(hit.required_refs) if hit.required_refs else "no refs"
        defaults = ", ".join(f"{name}={value}" for name, value in hit.defaults.items())
        piece = hit.piece
        lines.append(
            f"- {piece.id} [{piece.effect} via {piece.endpoint}]; "
            f"needs {refs}; defaults {defaults}: {piece.summary}"
        )
    lines.append(
        "First restate the editor's plan in one line, then expand it into "
        "ordered steps, each delegating to one piece above."
    )
    lines.append(
        "Worked examples (brief -> steps): "
        "'rainy neon key art' -> muse_image hero-key-art (aspect 16:9, style "
        "cinematic), then place it on the cut; "
        "'blur the background' -> sam3_mask subject-matte (promptKind text, "
        "trackMode tracked) on its own matte track; "
        "'warm trustworthy interview' -> grade warm-interview (intensity "
        "medium, source preset), name the preset; "
        "'huge words on every beat' -> motion_graphics kinetic-title "
        "(template title-card), cuts land on beats."
    )
    lines.append(
        "Taste, restrained and editorial, never flashy. "
        "Sound: risers into cuts, tape stops out of scenes, reverb and "
        "reverse-reverb tails across transitions, music matched to key and "
        "energy, always ducked under dialogue. "
        "Motion: momentum in, overshoot and settle (never a dead stop or a "
        "linear slide), a small bounce or tilt for emphasis, staggered "
        "entrances, one idea per beat."
    )
    lines.append("Propose a validated plan per effect. Omit nothing the pieces need.")
    developer = Message(role="developer", content="\n".join(lines))
    return [developer, Message(role="user", content=instruction)]


def build_brief_planner_messages(brief: str) -> list[Message]:
    """Turn a free-text brief into prompt messages for the planner model."""
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    from chair_agent.models import TOOLS

    tool_lines = "\n".join(f"- {tool.name}: {tool.summary}" for tool in TOOLS)
    developer = (
        "You are the Chair video planner. Turn the brief into an ordered JSON plan.\n"
        "Return a JSON object matching this schema:\n"
        "{\n"
        '  "intents": ["silence", ...],\n'
        '  "steps": [\n'
        '    {"tool": "<tool_name>", "goal": "<what this step achieves>"}\n'
        "  ]\n"
        "}\n"
        "Steps may ONLY use tools from this registry:\n"
        f"{tool_lines}\n"
        "Step 1 always restates the editor's plan: its goal starts with "
        "'Restate: ' and uses the tool that reads what the job needs "
        "(measure_audio for sound, get_frame for picture), then the later "
        "steps delegate the work.\n"
        "Worked examples (brief -> steps): "
        "'cut the dead air' -> measure_audio finds silent spans, editor_op "
        "cuts them, render_preview checks the cut; "
        "'warm interview grade' -> get_frame reads the look, grade applies "
        "the preset, render_preview checks skin tones; "
        "'punch in on the product' -> sam3_mask isolates it, editor_op "
        "punches in, render_preview checks the edges; "
        "'titles on every beat' -> transcribe finds the words, "
        "motion_graphics builds the cards, render_preview checks the beats.\n"
        "Taste, restrained and editorial, never flashy. "
        "Sound: risers into cuts, tape stops out of scenes, reverb and "
        "reverse-reverb tails across transitions, music matched to key and "
        "energy, always ducked under dialogue. "
        "Motion: momentum in, overshoot and settle, a small bounce or tilt "
        "for emphasis, staggered entrances, one idea per beat."
    )
    return [Message(role="developer", content=developer), Message(role="user", content=brief)]


def build_client(env: Mapping[str, str] | None = None) -> ModelClient:
    settings = load_settings(env)
    return ModelClient(
        models=settings.models,
        transport=HttpxTransport(settings.base_url),
        api_key=settings.api_key,
    )


def parse_model_selection(selection: str | None) -> tuple[str | None, str]:
    """Parse 'model (Provider)' format into (model_name, provider_id)."""
    if not selection or not selection.strip():
        return None, "meta"
    trimmed = selection.strip()
    if trimmed.endswith(")") and "(" in trimmed:
        model_part, prov_part = trimmed[:-1].rsplit("(", 1)
        return model_part.strip() or None, prov_part.strip().lower()
    return trimmed, "meta"


def build_client_for_model(
    model_spec: str | None = None,
    env: Mapping[str, str] | None = None,
) -> ModelClient | None:
    source: Mapping[str, str] = os.environ if env is None else env
    model_name, provider = parse_model_selection(model_spec)
    if provider == "meta":
        api_key = get_key("meta", env=env)
        if not api_key:
            return None
        base_url = _value(source, "META_API_BASE_URL") or DEFAULT_BASE_URL
        planner_model = model_name or _value(source, "CHAIR_PLANNER_MODEL")
        if not planner_model:
            return None
    elif provider == "openai":
        api_key = get_key("openai", env=env)
        if not api_key:
            return None
        base_url = _value(source, "OPENAI_API_BASE_URL") or OPENAI_DEFAULT_BASE_URL
        planner_model = model_name or _value(source, "CHAIR_PLANNER_MODEL") or "gpt-4o"
    else:
        return None

    return ModelClient(
        models=RoleModels(
            planner=planner_model,
            executor=_value(source, "CHAIR_EXECUTOR_MODEL"),
            verifier=_value(source, "CHAIR_VERIFIER_MODEL"),
        ),
        transport=HttpxTransport(base_url),
        api_key=api_key,
    )

