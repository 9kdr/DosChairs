import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, ConfigDict

from chair_agent.pieces import PieceHit

DEFAULT_BASE_URL = "https://api.meta.ai/v1"
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
    content: str


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
        api_key=_value(source, "META_API_KEY"),
    )


def configured_models(env: Mapping[str, str] | None = None) -> dict[str, str | None]:
    return load_settings(env).models.model_dump()


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
    lines.append("Propose a validated plan per effect. Omit nothing the pieces need.")
    developer = Message(role="developer", content="\n".join(lines))
    return [developer, Message(role="user", content=instruction)]


def build_client(env: Mapping[str, str] | None = None) -> ModelClient:
    settings = load_settings(env)
    return ModelClient(
        models=settings.models,
        transport=HttpxTransport(settings.base_url),
        api_key=settings.api_key,
    )
