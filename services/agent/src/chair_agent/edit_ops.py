"""Typed edit ops that emit changeset items.

Cut, trim, ripple, move, speed, transition, and marker builders map onto the
op enum in schemas/changeset.schema.json. Every emitted item is pending: a
proposed edit never changes the timeline. validate_changeset checks raw tool
output against that schema file and rejects invalid payloads before they
reach the UI.
"""

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field, ValidationError

SchemaOp = Literal[
    "add_clip",
    "remove_clip",
    "trim",
    "ripple",
    "move",
    "set_speed",
    "add_transition",
    "add_marker",
    "add_effect",
    "add_track",
    "set_gain",
    "mute_clip",
]

MarkerKind = Literal["beat", "hook", "fix", "broll", "user", "range"]

SCHEMA_VERSION = "0.1.0"


class ChangesetItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    op: SchemaOp
    target_id: str | None = Field(default=None, alias="targetId")
    beat_id: str | None = Field(default=None, alias="beatId")
    rationale: str = Field(min_length=1)
    patch: dict[str, Any] | None = None
    status: Literal["pending", "accepted", "rejected"] = "pending"


class Changeset(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal["0.1.0"] = Field(default=SCHEMA_VERSION, alias="schemaVersion")
    id: str = Field(min_length=1)
    base_revision: str = Field(alias="baseRevision")
    summary: str | None = None
    items: list[ChangesetItem] = []


class InvalidChangeset(ValueError):
    pass


def _schema_path() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root:
        return Path(root) / "schemas" / "changeset.schema.json"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "schemas" / "changeset.schema.json"
        if candidate.is_file():
            return candidate
    raise InvalidChangeset("schemas/changeset.schema.json not found")


def validate_changeset(data: Mapping[str, Any]) -> Changeset:
    """Validate raw tool output against schemas/changeset.schema.json.

    Returns the typed changeset. Raises InvalidChangeset on anything that
    does not match the schema, so bad tool output never reaches the UI.
    """
    if not isinstance(data, Mapping):
        raise InvalidChangeset("changeset must be an object")
    try:
        schema = json.loads(_schema_path().read_text(encoding="utf-8"))
    except OSError as error:
        raise InvalidChangeset(f"cannot read changeset schema: {error}") from error
    errors = list(Draft202012Validator(schema).iter_errors(dict(data)))
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.absolute_path) or "changeset"
        raise InvalidChangeset(f"invalid changeset at {where}: {first.message}")
    try:
        return Changeset.model_validate(data)
    except ValidationError as error:
        raise InvalidChangeset(f"invalid changeset: {error}") from error


def build_changeset(
    id: str,
    base_revision: str,
    items: list[ChangesetItem],
    summary: str | None = None,
) -> Changeset:
    """Assemble a changeset envelope from emitted items."""
    return Changeset(id=id, baseRevision=base_revision, summary=summary, items=items)


def _item(
    id: str,
    op: SchemaOp,
    rationale: str,
    patch: dict[str, Any],
    target_id: str | None = None,
    beat_id: str | None = None,
) -> ChangesetItem:
    return ChangesetItem(
        id=id, op=op, targetId=target_id, beatId=beat_id, rationale=rationale, patch=patch
    )


def cut_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    start_frames: int,
    frames: int,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Cut frames out of a clip. Maps to remove_clip with a frame range."""
    if start_frames < 0 or frames <= 0:
        raise ValueError("cut needs start_frames >= 0 and frames > 0")
    return _item(
        id, "remove_clip", rationale, {"startFrames": start_frames, "frames": frames},
        target_id=target_id, beat_id=beat_id,
    )


def trim_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    start_frames: int = 0,
    end_frames: int = 0,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Trim frames off the head, the tail, or both ends of a clip."""
    if start_frames < 0 or end_frames < 0 or (start_frames == 0 and end_frames == 0):
        raise ValueError("trim needs a positive start_frames or end_frames")
    return _item(
        id, "trim", rationale,
        {"trimStartFrames": start_frames, "trimEndFrames": end_frames},
        target_id=target_id, beat_id=beat_id,
    )


def ripple_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    shift_frames: int,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Ripple a clip (and everything after it) by a frame offset."""
    if shift_frames == 0:
        raise ValueError("ripple needs a non-zero shift_frames")
    return _item(
        id, "ripple", rationale, {"shiftFrames": shift_frames},
        target_id=target_id, beat_id=beat_id,
    )


def move_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    to_track_id: str,
    start_frames: int,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Move a clip to another track and start time."""
    if not to_track_id or start_frames < 0:
        raise ValueError("move needs a track id and start_frames >= 0")
    return _item(
        id, "move", rationale, {"toTrackId": to_track_id, "startFrames": start_frames},
        target_id=target_id, beat_id=beat_id,
    )


def speed_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    rate: float,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Change a clip's playback speed. Maps to set_speed."""
    if rate <= 0:
        raise ValueError("speed needs a rate above 0")
    return _item(
        id, "set_speed", rationale, {"rate": rate},
        target_id=target_id, beat_id=beat_id,
    )


def transition_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    kind: str,
    duration_frames: int,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Add a transition to a clip boundary. Maps to add_transition."""
    if not kind or duration_frames <= 0:
        raise ValueError("transition needs a kind and duration_frames > 0")
    return _item(
        id, "add_transition", rationale,
        {"transition": kind, "durationFrames": duration_frames},
        target_id=target_id, beat_id=beat_id,
    )


def marker_op(
    id: str,
    rationale: str,
    *,
    name: str,
    time_value: float,
    time_rate: float,
    kind: MarkerKind = "user",
    beat_id: str | None = None,
) -> ChangesetItem:
    """Add a timeline marker. The marker object rides in the patch."""
    if not name or time_value < 0 or time_rate <= 0:
        raise ValueError("marker needs a name and a valid time")
    return _item(
        id, "add_marker", rationale,
        {
            "marker": {
                "id": id,
                "name": name,
                "time": {"value": time_value, "rate": time_rate},
                "kind": kind,
                **({"beatId": beat_id} if beat_id else {}),
            }
        },
        beat_id=beat_id,
    )
