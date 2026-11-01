"""Story beat sheets: transcript plus brief become an editable plan.

build_beat_sheet scaffolds the five beats (hook, setup, turn, payoff,
outro) from transcript segments. The user refines the draft with
edit_beat, locks it with approve, and approved beats become pending
timeline markers via beats_to_markers. A pending proposed edit never
changes the timeline: markers ship as changeset items the UI applies
only after a human accepts.
"""

import json
import os
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from chair_agent.edit_ops import ChangesetItem, marker_op

BeatRole = Literal["hook", "setup", "turn", "payoff", "outro"]

ROLES: tuple[BeatRole, ...] = ("hook", "setup", "turn", "payoff", "outro")

Pacing = Literal["slow", "medium", "fast"]

SCHEMA_VERSION = "0.1.0"

_INTENT_LIMIT = 280


class Beat(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    role: BeatRole
    intent: str = Field(min_length=1)
    pacing: Pacing | None = None
    tone: str | None = None
    start_sec: float | None = Field(default=None, alias="startSec", ge=0)
    end_sec: float | None = Field(default=None, alias="endSec", ge=0)
    candidate_clip_ids: list[str] = Field(default_factory=list, alias="candidateClipIds")


class StoryPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal["0.1.0"] = Field(default=SCHEMA_VERSION, alias="schemaVersion")
    id: str = Field(min_length=1)
    brief: str = Field(min_length=1)
    target_duration_sec: float | None = Field(default=None, alias="targetDurationSec")
    status: Literal["draft", "approved"] = "draft"
    beats: list[Beat] = []


class TranscriptSegment(BaseModel):
    """One timed chunk of transcript. Times are optional; beats without a
    start time cannot become markers until the user sets one."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    text: str = Field(min_length=1)
    start_sec: float | None = Field(default=None, alias="startSec", ge=0)
    end_sec: float | None = Field(default=None, alias="endSec", ge=0)


class InvalidStoryPlan(ValueError):
    pass


class UnknownBeat(ValueError):
    pass


def _schema_path() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root:
        return Path(root) / "schemas" / "story-plan.schema.json"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "schemas" / "story-plan.schema.json"
        if candidate.is_file():
            return candidate
    raise InvalidStoryPlan("schemas/story-plan.schema.json not found")


def validate_story_plan(data: Mapping[str, Any]) -> StoryPlan:
    """Validate raw plan data against schemas/story-plan.schema.json.

    Returns the typed plan. Raises InvalidStoryPlan on anything that
    does not match, so bad tool output never reaches the UI.
    """
    if not isinstance(data, Mapping):
        raise InvalidStoryPlan("story plan must be an object")
    try:
        schema = json.loads(_schema_path().read_text(encoding="utf-8"))
    except OSError as error:
        raise InvalidStoryPlan(f"cannot read story-plan schema: {error}") from error
    errors = list(Draft202012Validator(schema).iter_errors(dict(data)))
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.absolute_path) or "story plan"
        raise InvalidStoryPlan(f"invalid story plan at {where}: {first.message}")
    try:
        return StoryPlan.model_validate(data)
    except ValidationError as error:
        raise InvalidStoryPlan(f"invalid story plan: {error}") from error


def _excerpt(text: str, limit: int) -> str:
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def build_beat_sheet(
    brief: str,
    segments: list[Mapping[str, Any] | TranscriptSegment],
    *,
    plan_id: str | None = None,
    target_duration_sec: float | None = None,
) -> StoryPlan:
    """Scaffold a draft beat sheet from a brief and transcript segments.

    Segments stay in order and split into five contiguous chunks, one per
    role. Each intent starts as an excerpt of its chunk for the user to
    rewrite; chunks with no coverage fall back to the brief.
    """
    if not brief or not brief.strip():
        raise InvalidStoryPlan("a beat sheet needs a non-empty brief")
    if not segments:
        raise InvalidStoryPlan("a beat sheet needs at least one transcript segment")
    try:
        timed = [TranscriptSegment.model_validate(item) for item in segments]
    except ValidationError as error:
        raise InvalidStoryPlan(f"invalid transcript segment: {error}") from error
    if target_duration_sec is None:
        target_duration_sec = next(
            (item.end_sec for item in reversed(timed) if item.end_sec is not None),
            next((item.start_sec for item in reversed(timed) if item.start_sec is not None), None),
        )
    first_start = next((item.start_sec for item in timed if item.start_sec is not None), 0.0)
    span = (
        max(0.0, target_duration_sec - first_start)
        if target_duration_sec is not None
        else None
    )
    count = len(timed)
    bounds = [index * count // len(ROLES) for index in range(len(ROLES) + 1)]
    beats = []
    for index, role in enumerate(ROLES):
        start, stop = bounds[index], bounds[index + 1]
        start_sec = timed[start].start_sec if count >= len(ROLES) and start < stop else None
        end_sec = timed[stop - 1].end_sec if count >= len(ROLES) and start < stop else None
        if start_sec is None and span is not None:
            start_sec = round(first_start + index * span / len(ROLES), 3)
        if end_sec is None and span is not None:
            end_sec = round(first_start + (index + 1) * span / len(ROLES), 3)
        beats.append(
            Beat(
                id=f"beat_{role}",
                role=role,
                intent=_chunk_intent(role, timed[start:stop], brief),
                startSec=start_sec,
                endSec=end_sec,
            )
        )
    return StoryPlan(
        id=plan_id or f"story_{uuid.uuid4().hex[:12]}",
        brief=brief.strip(),
        targetDurationSec=target_duration_sec,
        beats=beats,
    )


def _chunk_intent(role: BeatRole, chunk: list[TranscriptSegment], brief: str) -> str:
    if chunk:
        return _excerpt(" ".join(item.text for item in chunk), _INTENT_LIMIT)
    return _excerpt(f"{role.title()} beat for: {brief}", _INTENT_LIMIT)


def get_beat(plan: StoryPlan, beat_id: str) -> Beat:
    """Return one beat by id. Raises UnknownBeat for anything else."""
    for beat in plan.beats:
        if beat.id == beat_id:
            return beat
    raise UnknownBeat(f"unknown beat: {beat_id!r}")


def edit_beat(
    plan: StoryPlan,
    beat_id: str,
    *,
    intent: str | None = None,
    pacing: Pacing | None = None,
    tone: str | None = None,
    candidate_clip_ids: list[str] | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> StoryPlan:
    """Apply the user's edit to one beat. Only given fields change.

    Editing an approved plan returns it to draft: approval covers the
    exact beats the markers were built from.
    """
    index = next((n for n, beat in enumerate(plan.beats) if beat.id == beat_id), None)
    if index is None:
        raise UnknownBeat(f"unknown beat: {beat_id!r}")
    update: dict[str, Any] = {}
    if intent is not None:
        update["intent"] = intent
    if pacing is not None:
        update["pacing"] = pacing
    if tone is not None:
        update["tone"] = tone
    if candidate_clip_ids is not None:
        update["candidate_clip_ids"] = candidate_clip_ids
    if start_sec is not None:
        update["start_sec"] = start_sec
    if end_sec is not None:
        update["end_sec"] = end_sec
    try:
        revised = Beat.model_validate({**plan.beats[index].model_dump(), **update})
    except ValidationError as error:
        raise InvalidStoryPlan(f"invalid beat edit: {error}") from error
    beats = list(plan.beats)
    beats[index] = revised
    return plan.model_copy(update={"beats": beats, "status": "draft"})


def approve(plan: StoryPlan) -> StoryPlan:
    """Lock a complete draft. Approval needs all five roles."""
    missing = [role for role in ROLES if all(beat.role != role for beat in plan.beats)]
    if missing:
        raise InvalidStoryPlan(f"cannot approve: missing {', '.join(missing)} beat")
    return plan.model_copy(update={"status": "approved"})


def beats_to_markers(plan: StoryPlan, *, rate: float) -> list[ChangesetItem]:
    """Turn approved beats into pending add_marker changeset items.

    Each marker cites its beat, so later edits can cite the same beat.
    Raises unless the plan is approved and every beat has a start time.
    """
    if plan.status != "approved":
        raise InvalidStoryPlan("approve the beat sheet before making markers")
    if rate <= 0:
        raise ValueError("markers need a rate above 0")
    items = []
    for beat in plan.beats:
        if beat.start_sec is None:
            raise InvalidStoryPlan(
                f"beat {beat.id!r} has no startSec; "
                "set start times or supply timed transcript segments"
            )
        items.append(
            marker_op(
                f"marker_{beat.id}",
                f"Mark the {beat.role} beat.",
                name=f"{beat.role.title()}: {_excerpt(beat.intent, 60)}",
                time_value=beat.start_sec,
                time_rate=rate,
                kind="hook" if beat.role == "hook" else "beat",
                beat_id=beat.id,
            )
        )
    return items
