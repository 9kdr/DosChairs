"""Command: one Spark call turns a brief plus a plan into tasks.

The plan is story-plan beats today; the project-plan schema from #261
may land later, so a small adapter accepts both shapes and normalizes
them to (beat id, label) pairs. A validator rejects tasks that cite an
unknown beat id or an unknown section, with one repair retry before
the command fails.
"""

import json
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.client import Message, ModelClient

SECTIONS: tuple[str, ...] = ("cut", "sound", "motion", "effects", "color", "graphics")

_FALLBACK_DESCRIPTIONS: dict[str, str] = {
    "cut": "Cut: order and trim shots; land every edit on a beat.",
    "sound": "Sound: risers into cuts, tape stops out, music matched and ducked under dialogue.",
    "motion": "Motion: momentum in, overshoot and settle; one idea per beat.",
    "effects": "Effects: one validated effect per beat, restrained and never flashy.",
    "color": "Color: name the grade preset; skin tones stay honest.",
    "graphics": "Graphics: kinetic titles and cards timed to beats.",
}

try:
    from chair_agent.skills import describe_sections as _describe_sections
except ImportError:
    _describe_sections = None  # type: ignore[assignment]


class InvalidTasks(ValueError):
    pass


class Task(BaseModel):
    """One unit of crew work: a section goal tied to a plan beat."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1)
    beat_id: str = Field(min_length=1, alias="beatId")
    section: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    refs: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    acceptance: str = ""


def section_descriptions() -> dict[str, str]:
    """Section one-liners: skill prompts when #259 lands, inline fallback until then."""
    if _describe_sections is not None:
        try:
            got = _describe_sections()
        except Exception:
            got = None
        if isinstance(got, Mapping) and all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in got.items()
        ):
            merged = dict(_FALLBACK_DESCRIPTIONS)
            merged.update(got)
            return merged
    return dict(_FALLBACK_DESCRIPTIONS)


def plan_beats(plan: Any) -> list[dict[str, str]]:
    """Normalize a story plan or a project plan to (id, label) pairs."""
    if plan is None:
        raise InvalidTasks("crew command needs a plan")
    raw_beats: Any = None
    if hasattr(plan, "beats"):
        raw_beats = plan.beats
    elif isinstance(plan, Mapping):
        if isinstance(plan.get("beats"), list):
            raw_beats = plan["beats"]
        else:
            for key in ("phases", "sections", "stages", "scenes", "steps", "items"):
                value = plan.get(key)
                if isinstance(value, list) and value:
                    raw_beats = value
                    break
    if not isinstance(raw_beats, list) or not raw_beats:
        raise InvalidTasks("plan has no beats, phases, or steps to split")
    beats: list[dict[str, str]] = []
    for entry in raw_beats:
        if hasattr(entry, "id"):
            beat_id = getattr(entry, "id")
            label = str(getattr(entry, "intent", "") or getattr(entry, "goal", "") or beat_id)
        elif isinstance(entry, Mapping) and isinstance(entry.get("id"), str):
            beat_id = entry["id"]
            label = str(
                entry.get("intent") or entry.get("goal") or entry.get("title")
                or entry.get("name") or beat_id
            )
        else:
            continue
        if beat_id.strip():
            beats.append({"id": beat_id.strip(), "label": label.strip() or beat_id.strip()})
    if not beats:
        raise InvalidTasks("plan has no usable beat ids")
    return beats


def _parse_tasks(text: str) -> list[dict[str, Any]]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        lines = lines[1:] if len(lines) > 1 else []
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise InvalidTasks(f"command did not return JSON tasks: {error}") from error
    if isinstance(data, Mapping) and isinstance(data.get("tasks"), list):
        data = data["tasks"]
    if not isinstance(data, list) or not data:
        raise InvalidTasks("command did not return a task list")
    if not all(isinstance(item, dict) for item in data):
        raise InvalidTasks("command tasks must be objects")
    return data


def validate_tasks(raw: list[dict[str, Any]], beat_ids: set[str]) -> list[Task]:
    """Reject tasks with unknown beat ids or unknown sections."""
    problems: list[str] = []
    tasks: list[Task] = []
    for index, item in enumerate(raw):
        try:
            task = Task.model_validate(item)
        except Exception as error:
            problems.append(f"task {index} is malformed: {error}")
            continue
        if task.beat_id not in beat_ids:
            problems.append(f"task {task.id} cites unknown beat {task.beat_id!r}")
        if task.section not in SECTIONS:
            problems.append(f"task {task.id} uses unknown section {task.section!r}")
        tasks.append(task)
    if problems:
        raise InvalidTasks("; ".join(problems))
    return tasks


def _command_messages(brief: str, beats: list[dict[str, str]]) -> list[Message]:
    sections = "\n".join(f"- {name}: {desc}" for name, desc in section_descriptions().items())
    beat_lines = "\n".join(f"- {beat['id']}: {beat['label']}" for beat in beats)
    developer = (
        "You are the Chair crew command. Split the brief into one task per "
        "section the plan needs, keeping every task tied to one plan beat.\n"
        "Return a JSON array (or {\"tasks\": [...]}) of tasks with keys "
        "id, beatId, section, goal, refs, constraints, acceptance.\n"
        f"Sections (section must be one of these):\n{sections}\n"
        "Rules: every task cites exactly one beatId from the plan below; "
        "never invent a beat id. Cover cut, sound, motion, and effects when "
        "the brief needs them; add color and graphics only when asked. "
        "One idea per task."
    )
    user = f"Brief: {brief}\nPlan beats:\n{beat_lines}"
    return [Message(role="developer", content=developer), Message(role="user", content=user)]


def run_command(
    brief: str,
    plan: Any,
    client: ModelClient | None,
    *,
    model: str | None = None,
) -> list[Task]:
    """One Spark call: brief plus plan become validated tasks.

    A validator rejects unknown beat ids and unknown sections; one
    repair retry runs before the command fails.
    """
    if not brief.strip():
        raise InvalidTasks("crew command needs a non-empty brief")
    if client is None:
        raise InvalidTasks("crew command needs a model client")
    beats = plan_beats(plan)
    beat_ids = {beat["id"] for beat in beats}
    messages = _command_messages(brief.strip(), beats)
    if model:
        text = client.complete_model(model, messages).text
    else:
        text = client.execute(messages).text
    try:
        return validate_tasks(_parse_tasks(text), beat_ids)
    except InvalidTasks as first_error:
        repair = messages + [
            Message(
                role="user",
                content=f"That task list was rejected: {first_error}. "
                "Return a corrected JSON task list using only known beat ids "
                f"({', '.join(sorted(beat_ids))}) and known sections "
                f"({', '.join(SECTIONS)}).",
            )
        ]
        if model:
            retry_text = client.complete_model(model, repair).text
        else:
            retry_text = client.execute(repair).text
        return validate_tasks(_parse_tasks(retry_text), beat_ids)
