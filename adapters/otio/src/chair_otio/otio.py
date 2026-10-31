"""Export a Chair timeline to OTIO JSON.

Video and audio tracks become OTIO tracks; subtitle and effect tracks become
video tracks tagged with their Chair kind in metadata. Clips carry their
source and timeline ranges, effects name the editor preset, and markers sit
on the track stack (OTIO timelines hold no markers) with their kind and beat
id in metadata and their comment in OTIO's native comment field. Speed
differences between the source and timeline ranges become a LinearTimeWarp
effect. Story plan, style profile, global start, and clip metadata ride
along in metadata so nothing Chair-specific is dropped silently.

What does not survive the trip is in the capability manifest: keyframed
animation inside effect parameters (baked into the clip) and Fusion comps
(a pre-rendered overlay track). The source file is never opened.
"""

from __future__ import annotations

import json
from fractions import Fraction
from typing import Any

MARKER_KINDS = frozenset({"beat", "hook", "fix", "broll", "user", "range"})
TRACK_KINDS = frozenset({"video", "audio", "subtitle", "effect"})
TRACK_OTIO_KIND = {"video": "Video", "audio": "Audio", "subtitle": "Video", "effect": "Video"}
MARKER_COLORS = {
    "beat": "GREEN",
    "hook": "YELLOW",
    "fix": "RED",
    "broll": "BLUE",
    "user": "WHITE",
    "range": "PURPLE",
}


def otio_from_timeline(timeline: dict[str, Any]) -> str:
    """Write a Chair timeline to an OTIO document. The source file is not opened."""
    if not isinstance(timeline, dict):
        raise TypeError("Timeline must be an object.")
    for key in ("id", "name", "rate", "tracks", "markers"):
        if key not in timeline:
            raise ValueError(f"Timeline is missing {key}.")
    num, den = _rate_pair(timeline["rate"])
    timeline_id = str(timeline["id"]).strip()
    if not timeline_id:
        raise ValueError("Timeline id is empty.")
    tracks = timeline["tracks"]
    if not isinstance(tracks, list):
        raise TypeError("Timeline tracks must be a list.")
    markers = timeline["markers"]
    if not isinstance(markers, list):
        raise TypeError("Timeline markers must be a list.")

    metadata: dict[str, Any] = {"chair_timeline_id": timeline_id}
    if timeline.get("storyPlanId"):
        metadata["chair_story_plan_id"] = str(timeline["storyPlanId"])
    if timeline.get("styleProfileId"):
        metadata["chair_style_profile_id"] = str(timeline["styleProfileId"])
    global_start = None
    if "globalStart" in timeline:
        global_start = _rational_time(timeline["globalStart"], "Timeline globalStart")

    document = {
        "OTIO_SCHEMA": "Timeline.1",
        "name": str(timeline["name"]),
        "global_start_time": global_start,
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "children": [_track(track, num, den) for track in tracks],
            "markers": [_marker(marker, num, den) for marker in markers],
            "metadata": {},
        },
        "metadata": metadata,
    }
    return json.dumps(document, indent=2) + "\n"


def _rate_pair(rate: Any) -> tuple[int, int]:
    if not isinstance(rate, dict):
        raise TypeError("Timeline rate must be an object.")
    num = rate.get("num")
    den = rate.get("den")
    if type(num) is not int or type(den) is not int or num < 1 or den < 1:
        raise ValueError("Timeline rate must be positive integers.")
    return num, den


def _track(track: Any, num: int, den: int) -> dict[str, Any]:
    if not isinstance(track, dict):
        raise TypeError("Timeline track must be an object.")
    for key in ("id", "kind", "name", "clips"):
        if key not in track:
            raise ValueError(f"Track is missing {key}.")
    kind = track["kind"]
    if kind not in TRACK_KINDS:
        raise ValueError(f"Track kind {kind!r} is not a Chair track.")
    clips = track["clips"]
    if not isinstance(clips, list):
        raise TypeError("Track clips must be a list.")
    return {
        "OTIO_SCHEMA": "Track.1",
        "name": str(track["name"]),
        "kind": TRACK_OTIO_KIND[kind],
        "children": _children(clips, num, den),
        "metadata": {"chair_track_id": str(track["id"]), "chair_kind": kind},
    }


def _children(clips: list[Any], num: int, den: int) -> list[dict[str, Any]]:
    ordered = _ordered(clips, num, den)
    children: list[dict[str, Any]] = []
    cursor = Fraction(0)
    for clip in ordered:
        start = _position(clip["timelineRange"], num, den, f"Clip {clip['id']!r} timeline start")
        duration = _position(
            clip["timelineRange"], num, den, f"Clip {clip['id']!r} timeline duration", "duration"
        )
        if duration <= 0:
            raise ValueError(f"Clip {clip['id']!r} has no timeline duration.")
        if start < 0:
            raise ValueError(f"Clip {clip['id']!r} timeline start is negative.")
        if start < cursor:
            raise ValueError(f"Clip {clip['id']!r} overlaps another clip on the track.")
        if start > cursor:
            children.append(_gap(start - cursor, num, den))
        children.append(_clip(clip, num, den, duration))
        cursor = start + duration
    return children


def _ordered(clips: list[Any], num: int, den: int) -> list[dict[str, Any]]:
    ordered: list[tuple[Fraction, str, int, dict[str, Any]]] = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            raise TypeError("Clip must be an object.")
        for key in ("id", "name", "sourceRange", "timelineRange"):
            if key not in clip:
                raise ValueError(f"Clip is missing {key}.")
        start = _position(clip["timelineRange"], num, den, "timeline start")
        ordered.append((start, str(clip.get("id", "")), index, clip))
    ordered.sort(key=lambda item: (item[0], item[1], item[2]))
    return [clip for _, _, _, clip in ordered]


def _clip(clip: dict[str, Any], num: int, den: int, duration: Fraction) -> dict[str, Any]:
    label = f"Clip {clip['id']!r}"
    source_start = _rational_time(clip["sourceRange"]["start"], f"{label} source start")
    source_duration = _rational_time(clip["sourceRange"]["duration"], f"{label} source duration")
    source_frames = _position(clip["sourceRange"], num, den, f"{label} source start")
    source_span = _position(clip["sourceRange"], num, den, f"{label} source duration", "duration")
    if source_span <= 0:
        raise ValueError(f"{label} has no source duration.")
    if source_frames < 0:
        raise ValueError(f"{label} source start is negative.")
    metadata: dict[str, Any] = {"chair_clip_id": str(clip["id"])}
    clip_metadata = clip.get("metadata")
    if clip_metadata:
        if not isinstance(clip_metadata, dict):
            raise TypeError(f"{label} metadata must be an object.")
        metadata["chair_metadata"] = clip_metadata
    media = clip.get("mediaRef")
    media_text = str(media) if isinstance(media, str) and media.strip() else ""
    source_range = {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": source_start,
        "duration": source_duration,
    }
    item: dict[str, Any] = {
        "OTIO_SCHEMA": "Clip.1",
        "name": str(clip["name"]),
        "source_range": source_range,
        "media_reference": _media_reference(media_text, source_range),
        "metadata": metadata,
    }
    effects = [_effect(effect) for effect in clip.get("effects") or []]
    if source_span != duration:
        effects.append(
            {
                "OTIO_SCHEMA": "LinearTimeWarp.1",
                "name": "speed",
                "effect_name": "LinearTimeWarp",
                "time_scalar": float(source_span / duration),
                "metadata": {},
            }
        )
    if effects:
        item["effects"] = effects
    return item


def _media_reference(media_text: str, source_range: dict[str, Any]) -> dict[str, Any]:
    available = {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": dict(source_range["start_time"]),
        "duration": dict(source_range["duration"]),
    }
    if media_text:
        return {
            "OTIO_SCHEMA": "ExternalReference.1",
            "target_url": media_text,
            "available_range": available,
            "metadata": {},
        }
    return {
        "OTIO_SCHEMA": "MissingReference.1",
        "available_range": available,
        "metadata": {},
    }


def _effect(effect: Any) -> dict[str, Any]:
    if not isinstance(effect, dict):
        raise TypeError("Effect must be an object.")
    for key in ("id", "presetName", "params"):
        if key not in effect:
            raise ValueError(f"Effect is missing {key}.")
    params = effect["params"]
    if not isinstance(params, dict):
        raise TypeError("Effect params must be an object.")
    enabled = effect.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError(f"Effect {effect['id']!r} enabled must be a boolean.")
    item: dict[str, Any] = {
        "OTIO_SCHEMA": "Effect.1",
        "name": str(effect["id"]),
        "effect_name": str(effect["presetName"]),
        "metadata": {"chair_params": params},
    }
    if enabled is False:
        item["enabled"] = False
    return item


def _gap(span: Fraction, num: int, den: int) -> dict[str, Any]:
    rate = num if den == 1 else num / den
    return {
        "OTIO_SCHEMA": "Gap.1",
        "name": "Gap",
        "source_range": {
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": {"OTIO_SCHEMA": "RationalTime.1", "value": 0, "rate": rate},
            "duration": {"OTIO_SCHEMA": "RationalTime.1", "value": _number(span), "rate": rate},
        },
        "metadata": {},
    }


def _marker(marker: Any, num: int, den: int) -> dict[str, Any]:
    if not isinstance(marker, dict):
        raise TypeError("Marker must be an object.")
    for key in ("id", "name", "time", "kind"):
        if key not in marker:
            raise ValueError(f"Marker is missing {key}.")
    kind = marker["kind"]
    if kind not in MARKER_KINDS:
        raise ValueError(f"Marker kind {kind!r} is not a Chair marker.")
    label = f"Marker {marker['id']!r}"
    time = _rational_time(marker["time"], label)
    if _position(marker["time"], num, den, label, part=None) < 0:
        raise ValueError(f"{label} is negative.")
    duration: dict[str, Any] | None = None
    if marker.get("duration") is not None:
        duration = _rational_time(marker["duration"], f"{label} duration")
        if _position(marker["duration"], num, den, f"{label} duration", part=None) < 0:
            raise ValueError(f"{label} duration is negative.")
    if duration is None:
        duration = {"OTIO_SCHEMA": "RationalTime.1", "value": 0, "rate": time["rate"]}
    metadata: dict[str, Any] = {"chair_marker_id": str(marker["id"]), "chair_kind": kind}
    if marker.get("beatId"):
        metadata["chair_beatid"] = str(marker["beatId"])
    return {
        "OTIO_SCHEMA": "Marker.2",
        "name": str(marker["name"]),
        "marked_range": {
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": time,
            "duration": duration,
        },
        "color": MARKER_COLORS[kind],
        "comment": str(marker.get("comment") or ""),
        "metadata": metadata,
    }


def _rational_time(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or "value" not in value or "rate" not in value:
        raise ValueError(f"{label} must be a rational time.")
    number = value["value"]
    rate = value["rate"]
    if isinstance(number, bool) or not isinstance(number, (int, float)):
        raise ValueError(f"{label} value must be a number.")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError(f"{label} rate must be positive.")
    return {"OTIO_SCHEMA": "RationalTime.1", "value": number, "rate": rate}


def _position(
    range_or_time: Any, num: int, den: int, label: str, part: str | None = "start"
) -> Fraction:
    if part is None:
        rational = range_or_time
    else:
        if not isinstance(range_or_time, dict) or part not in range_or_time:
            raise ValueError(f"{label} is missing.")
        rational = range_or_time[part]
    if not isinstance(rational, dict) or "value" not in rational or "rate" not in rational:
        raise ValueError(f"{label} must be a rational time.")
    number = rational["value"]
    rate = rational["rate"]
    if isinstance(number, bool) or not isinstance(number, (int, float)):
        raise ValueError(f"{label} value must be a number.")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError(f"{label} rate must be positive.")
    return Fraction(str(number)) * Fraction(num, den) / Fraction(str(rate))


def _number(value: Fraction) -> int | float:
    if value.denominator == 1:
        return int(value)
    return float(value)
