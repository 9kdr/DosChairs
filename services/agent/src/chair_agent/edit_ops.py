"""Typed edit ops that emit changeset items.

Cut, trim, ripple, move, speed, transition, and marker builders map onto the
op enum in schemas/changeset.schema.json. Every emitted item applies onto a
copy — never source media, never the person's timeline in place — with its
inverse kept in history so it stays undoable. validate_changeset checks raw
tool output against that schema file and rejects invalid payloads before
they reach the UI.
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
    "remove_transition",
    "add_marker",
    "remove_marker",
    "add_effect",
    "remove_effect",
    "add_track",
    "remove_track",
    "set_gain",
    "mute_clip",
]

MarkerKind = Literal["beat", "hook", "fix", "broll", "user", "range"]

SCHEMA_VERSION = "0.1.0"


class ChangesetFallback(BaseModel):
    """The adapter could not place this item directly: capability id plus
    the plain-words substitute the reviewer accepts instead."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    capability: str = Field(min_length=1)
    reason: str = Field(min_length=1)


class ChangesetItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    op: SchemaOp
    target_id: str | None = Field(default=None, alias="targetId")
    beat_id: str | None = Field(default=None, alias="beatId")
    spec_ref: str | None = Field(default=None, alias="specRef")
    rationale: str = Field(min_length=1)
    patch: dict[str, Any] | None = None
    fallback: ChangesetFallback | None = None
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
    spec_ref: str | None = None,
) -> ChangesetItem:
    return ChangesetItem(
        id=id, op=op, targetId=target_id, beatId=beat_id, specRef=spec_ref,
        rationale=rationale, patch=patch,
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


def sfx_track_op(
    id: str,
    rationale: str,
    *,
    track_id: str = "audio-sfx-1",
    name: str = "SFX",
    beat_id: str | None = None,
) -> ChangesetItem:
    """Add a NEW audio track for placed sound cues. Nothing is overwritten."""
    if not track_id:
        raise ValueError("sfx track needs a track id")
    return _item(
        id, "add_track", rationale,
        {"track": {"id": track_id, "kind": "audio", "name": name, "clips": []},
         "trackId": track_id},
        beat_id=beat_id,
    )


def sfx_clip_op(
    id: str,
    track_id: str,
    clip_id: str,
    rationale: str,
    *,
    media_ref: str,
    name: str,
    start_seconds: float,
    duration_seconds: float,
    rate: float = 30.0,
    gain_db: float = -10.0,
    kind: str = "sfx",
    source: str = "synth",
    license: str = "generated",
    beat_id: str | None = None,
    source_start_seconds: float = 0.0,
) -> ChangesetItem:
    """Place one SFX file on the SFX track as a full clip snapshot.

    The snapshot carries sourceRange/timelineRange so the desktop applier
    can place it without guessing; kind/gain ride alongside for the
    adapter. Risers end exactly on the cut: pass start = cut - duration.
    A riser trimmed at the head keeps its peak: pass source_start_seconds
    so the source range starts inside the file.
    """
    if not media_ref.strip():
        raise ValueError("sfx clip needs a media_ref file path")
    if start_seconds < 0 or duration_seconds <= 0 or rate <= 0:
        raise ValueError("sfx clip needs start_seconds >= 0, duration > 0, rate > 0")
    if source_start_seconds < 0:
        raise ValueError("sfx clip needs source_start_seconds >= 0")
    if gain_db > 0:
        raise ValueError("sfx gain stays at or below 0 dB")
    return _item(
        id, "add_clip", rationale,
        {
            "clip": {
                "id": clip_id,
                "name": name,
                "mediaRef": media_ref.strip(),
                "sourceRange": {
                    "start": {"value": round(source_start_seconds * rate), "rate": rate},
                    "duration": {"value": round(duration_seconds * rate), "rate": rate},
                },
                "timelineRange": {
                    "start": {"value": round(start_seconds * rate), "rate": rate},
                    "duration": {"value": round(duration_seconds * rate), "rate": rate},
                },
            },
            "clipId": clip_id,
            "kind": kind,
            "gainDb": gain_db,
            "source": source,
            "license": license,
        },
        target_id=track_id, beat_id=beat_id,
    )


def stills_track_op(
    id: str,
    rationale: str,
    *,
    track_id: str = "video-stills-1",
    name: str = "Stills",
    beat_id: str | None = None,
) -> ChangesetItem:
    """Add a NEW video track for generated stills. Nothing is overwritten."""
    if not track_id:
        raise ValueError("stills track needs a track id")
    return _item(
        id, "add_track", rationale,
        {"track": {"id": track_id, "kind": "video", "name": name, "clips": []},
         "trackId": track_id},
        beat_id=beat_id,
    )


def still_clip_op(
    id: str,
    track_id: str,
    clip_id: str,
    rationale: str,
    *,
    media_ref: str,
    name: str,
    start_seconds: float,
    duration_seconds: float,
    rate: float = 30.0,
    kind: str = "still",
    source: str = "muse-image",
    license: str = "generated",
    beat_id: str | None = None,
) -> ChangesetItem:
    """Place one generated still on the stills track as a full clip snapshot.

    Same shape as the SFX clip op: sourceRange/timelineRange so the
    desktop applier can place it without guessing. A still holds for its
    whole timeline range; match cuts time the starts on beats.
    """
    if not media_ref.strip():
        raise ValueError("still clip needs a media_ref file path")
    if start_seconds < 0 or duration_seconds <= 0 or rate <= 0:
        raise ValueError("still clip needs start_seconds >= 0, duration > 0, rate > 0")
    return _item(
        id, "add_clip", rationale,
        {
            "clip": {
                "id": clip_id,
                "name": name,
                "mediaRef": media_ref.strip(),
                "sourceRange": {
                    "start": {"value": 0, "rate": rate},
                    "duration": {"value": round(duration_seconds * rate), "rate": rate},
                },
                "timelineRange": {
                    "start": {"value": round(start_seconds * rate), "rate": rate},
                    "duration": {"value": round(duration_seconds * rate), "rate": rate},
                },
            },
            "clipId": clip_id,
            "kind": kind,
            "source": source,
            "license": license,
        },
        target_id=track_id, beat_id=beat_id,
    )


def duck_keyframes(
    regions_seconds: list[tuple[float, float]],
    *,
    duck_db: float = -12.0,
    ramp_seconds: float = 0.2,
) -> list[dict[str, float]]:
    """Volume keyframes ducking music under dialogue: ~-12 dB with ramps.

    Each region gets four points (down-ramp, hold, hold, up-ramp), clamped
    at zero. Ramps default to 0.2s, inside the 150-300 ms window.
    """
    if duck_db >= 0:
        raise ValueError("ducking gain stays below 0 dB")
    if not 0.15 <= ramp_seconds <= 0.3:
        raise ValueError("ducking ramps stay within 150-300 ms")
    points: list[dict[str, float]] = []
    for start, end in sorted(regions_seconds):
        if end <= start:
            continue
        down = max(0.0, start - ramp_seconds)
        points.extend([
            {"timeSeconds": round(down, 3), "gainDb": 0.0},
            {"timeSeconds": round(start, 3), "gainDb": duck_db},
            {"timeSeconds": round(end, 3), "gainDb": duck_db},
            {"timeSeconds": round(end + ramp_seconds, 3), "gainDb": 0.0},
        ])
    return points


def duck_op(
    id: str,
    target_id: str,
    rationale: str,
    *,
    regions_seconds: list[tuple[float, float]],
    duck_db: float = -12.0,
    ramp_seconds: float = 0.2,
    beat_id: str | None = None,
) -> ChangesetItem:
    """Duck music under dialogue regions with volume keyframes on a copy.

    A set_gain item: the adapter interprets the keyframes (or records its
    fallback), the timeline IR itself is untouched.
    """
    keyframes = duck_keyframes(
        regions_seconds, duck_db=duck_db, ramp_seconds=ramp_seconds
    )
    if not keyframes:
        raise ValueError("ducking needs at least one dialogue region")
    return _item(
        id, "set_gain", rationale,
        {
            "gainDb": duck_db,
            "regionsSeconds": [[s, e] for s, e in sorted(regions_seconds) if e > s],
            "rampSeconds": ramp_seconds,
            "keyframes": keyframes,
        },
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
