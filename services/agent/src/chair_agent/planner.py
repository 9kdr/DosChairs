"""Planner: model-backed free-text planning over the tool registry with rule fallback.

Reads a brief, detects intents, and emits an ordered plan of tool steps against
the proxy. With META_API_KEY and CHAIR_PLANNER_MODEL configured, calls the planner
model; without a key or on model error / invalid answer, falls back to v1 rules.
"""

import json
import threading
import time
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.client import (
    ModelClient,
    build_brief_planner_messages,
    build_client,
    build_client_for_model,
    key_configured,
    load_settings,
)
from chair_agent.models import TOOLS

_TOOL_NAMES = frozenset(tool.name for tool in TOOLS)

#: Sound-design intents the executor can dispatch to SFX and ducking ops.
#: The model planner already emits these; the rules fallback detects them
#: from the same brief words so a keyless run still plans them.
SOUND_INTENTS = ("riser_into_cut", "tape_stop_outro", "duck_music_under_dialogue")

DISPATCHABLE_INTENTS = frozenset({"silence", "filler", *SOUND_INTENTS})

#: Canonical spellings the planner prompt asks the model for. The model
#: still invents variants ("tape_stop_out"), so the executor canonicalizes
#: by keyword instead of exact-matching.
CANONICAL_INTENTS = ("silence", "filler", *SOUND_INTENTS)

_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {"plans": 0, "last_plan_ms": None, "last_error": None}


def status_snapshot() -> dict[str, Any]:
    """Planner counters: plans made, last plan wall time, last error."""
    with _STATUS_LOCK:
        return dict(_STATUS)


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tool: str
    goal: str


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    brief: str
    intents: list[str]
    steps: list[PlanStep]
    planner: str = Field(default="rules", exclude=True)
    message: str | None = Field(default=None, exclude=True)


def _intents(brief: str) -> list[str]:
    lowered = brief.lower()
    intents = []
    if "silenc" in lowered:
        intents.append("silence")
    if "filler" in lowered:
        intents.append("filler")
    if "riser" in lowered or "build-up" in lowered or "buildup" in lowered:
        intents.append("riser_into_cut")
    if "tape stop" in lowered or "tape-stop" in lowered or "tape_stop" in lowered:
        intents.append("tape_stop_outro")
    if "duck" in lowered:
        intents.append("duck_music_under_dialogue")
    return intents


def _parse_completion_json(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    payload = json.loads(trimmed)
    if not isinstance(payload, dict):
        raise ValueError("model completion must be a JSON object")
    return payload


def plan_rules(brief: str) -> Plan:
    """Turn a short brief into an ordered plan of tool steps using v1 rules."""
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    intents = _intents(brief)
    if not intents:
        raise ValueError(
            "brief names nothing Chair plans yet: say 'silence', 'filler', "
            "'riser', 'tape stop', or 'duck'"
        )
    steps = []
    sound = [intent for intent in intents if intent in SOUND_INTENTS]
    if "silence" in intents or "duck_music_under_dialogue" in intents:
        steps.append(PlanStep(tool="measure_audio", goal="find silent spans on the proxy"))
    if "filler" in intents or "duck_music_under_dialogue" in intents:
        steps.append(PlanStep(tool="transcribe", goal="find filler words on the proxy"))
    if sound:
        steps.append(
            PlanStep(
                tool="editor_op",
                goal="place SFX and ducking on a new audio track: " + ", ".join(sound),
            )
        )
    elif "silence" in intents or "filler" in intents:
        steps.append(PlanStep(tool="editor_op", goal="cut the flagged spans"))
    steps.append(PlanStep(tool="render_preview", goal="render a low-res preview"))
    unknown = [step.tool for step in steps if step.tool not in _TOOL_NAMES]
    if unknown:
        raise ValueError(f"plan uses unknown tools: {', '.join(unknown)}")
    return Plan(brief=brief, intents=intents, steps=steps, planner="rules")


def plan_with_model(brief: str, client: ModelClient) -> Plan:
    """Turn a free-text brief into a Plan using the planner model.

    Validates that steps only use tool names from models.TOOLS and rejects
    unknown tools.
    """
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    messages = build_brief_planner_messages(brief)
    completion = client.plan(messages)
    data = _parse_completion_json(completion.text)

    raw_intents = data.get("intents")
    if not isinstance(raw_intents, list) or not raw_intents:
        raise ValueError("model plan must have a non-empty 'intents' list")
    intents = [str(item).strip() for item in raw_intents if str(item).strip()]
    if not intents:
        raise ValueError("model plan must have at least one non-empty intent")

    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("model plan must have a non-empty 'steps' list")

    steps: list[PlanStep] = []
    for step_data in raw_steps:
        if not isinstance(step_data, dict):
            raise ValueError("each step must be an object")
        tool = step_data.get("tool")
        goal = step_data.get("goal", "")
        if not isinstance(tool, str) or not tool.strip():
            raise ValueError("each step must have a non-empty 'tool' name")
        clean_tool = tool.strip()
        if clean_tool not in _TOOL_NAMES:
            raise ValueError(f"plan uses unknown tool: {clean_tool!r}")
        steps.append(PlanStep(tool=clean_tool, goal=str(goal).strip()))

    undispatched = [i for i in intents if i not in DISPATCHABLE_INTENTS]
    message = (
        f"Cannot dispatch intents yet: {', '.join(undispatched)}"
        if undispatched
        else None
    )
    return Plan(brief=brief, intents=intents, steps=steps, planner="model", message=message)


def plan_brief(
    brief: str,
    *,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
    model: str | None = None,
) -> Plan:
    """Turn a brief into an ordered plan of tool steps.

    Uses the planner model when configured; falls back to rules without a
    key or on model error / invalid answer.
    """
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")

    started = time.perf_counter()
    try:
        plan = _plan_brief(brief, client=client, env=env, model=model)
    except Exception as error:
        with _STATUS_LOCK:
            _STATUS["last_error"] = f"{type(error).__name__}: {error}"
        raise
    with _STATUS_LOCK:
        _STATUS["plans"] += 1
        _STATUS["last_plan_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return plan


def _plan_brief(
    brief: str,
    *,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
    model: str | None = None,
) -> Plan:
    active_client = client
    if active_client is None:
        try:
            active_client = build_client_for_model(model, env=env)
        except Exception:
            active_client = None

    if active_client is None and key_configured("meta", env=env):
        settings = load_settings(env)
        if settings.models.planner:
            try:
                active_client = build_client(env)
            except Exception:
                active_client = None

    if active_client is not None:
        try:
            return plan_with_model(brief, active_client)
        except Exception:
            return plan_rules(brief)

    return plan_rules(brief)

