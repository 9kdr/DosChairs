"""Map a Resolve scripting snapshot to schemas/timeline.schema.json.

The mapper only sees plain dicts, so tests never launch Resolve. The live
caller reads the current timeline and does not write to Resolve or to media.
"""

from __future__ import annotations

from typing import Any

SCHEMA_VERSION = "0.1.0"
Frame = int | float
CHAIR_MARKER_KINDS = frozenset({"beat", "hook", "fix", "broll", "user", "range"})
TRACK_KINDS = {
    "video": "video",
    "audio": "audio",
    "subtitle": "subtitle",
}
TRACK_PREFIX = {"video": "v", "audio": "a", "subtitle": "s"}

# Resolve's timelineFrameRate labels. Unknown labels are rejected rather than guessed.
FRAME_RATES: dict[str, tuple[int, int]] = {
    "16": (16, 1),
    "18": (18, 1),
    "23.976": (24000, 1001),
    "24": (24, 1),
    "25": (25, 1),
    "29.97": (30000, 1001),
    "30": (30, 1),
    "47.952": (48000, 1001),
    "48": (48, 1),
    "50": (50, 1),
    "59.94": (60000, 1001),
    "60": (60, 1),
    "72": (72, 1),
    "90": (90, 1),
    "96": (96, 1),
    "119.88": (120000, 1001),
    "120": (120, 1),
}


class ResolveClosedError(RuntimeError):
    """Resolve Studio is not running, or it has no open project timeline."""


def timeline_from_resolve(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build Chair timeline JSON from a Resolve-shaped dict.

    Clip `end` and `source_end_frame` are exclusive, matching Resolve
    GetEnd and GetSourceEndFrame. Grades, speed, and Fusion comps are ignored.
    """
    if not isinstance(snapshot, dict):
        raise TypeError("Resolve snapshot must be a dict.")

    num, den = _frame_rate(snapshot.get("frame_rate"))
    name = _display_name(snapshot)
    timeline: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "id": _timeline_id(snapshot, name),
        "name": name,
        "rate": {"num": num, "den": den},
    }
    if snapshot.get("start_frame") is not None:
        timeline["globalStart"] = _time(snapshot["start_frame"], num, den)
    timeline["tracks"] = [
        _track(track, num, den) for track in _as_list(snapshot.get("tracks"), "tracks")
    ]
    timeline["markers"] = _markers(snapshot.get("markers") or {}, num, den)
    return timeline


def read_current_timeline() -> dict[str, Any]:
    """Read the timeline open in Resolve Studio."""
    return timeline_from_resolve(_snapshot(_scriptapp()))


def _scriptapp() -> Any:
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError as exc:
        raise ResolveClosedError(
            "DaVinci Resolve Studio is closed, or DaVinciResolveScript is not installed. "
            "Open Resolve Studio and try again."
        ) from exc
    resolve = dvr_script.scriptapp("Resolve")
    if not resolve:
        raise ResolveClosedError(
            "DaVinci Resolve Studio is closed. Open Resolve Studio and try again."
        )
    return resolve


def _snapshot(resolve: Any) -> dict[str, Any]:
    project_manager = _maybe(resolve, "GetProjectManager")
    project = _maybe(project_manager, "GetCurrentProject") if project_manager else None
    if project is None:
        raise ResolveClosedError(
            "Resolve Studio has no project open. Open a project and try again."
        )
    timeline = _maybe(project, "GetCurrentTimeline")
    if timeline is None:
        raise ResolveClosedError(
            "Resolve Studio has no current timeline. Open a timeline and try again."
        )

    tracks = []
    for track_type in ("video", "audio", "subtitle"):
        count = int(_maybe(timeline, "GetTrackCount", track_type) or 0)
        for index in range(1, count + 1):
            items = _maybe(timeline, "GetItemListInTrack", track_type, index) or []
            tracks.append(
                {
                    "track_type": track_type,
                    "index": index,
                    "name": _maybe(timeline, "GetTrackName", track_type, index) or "",
                    "items": [_snapshot_item(item) for item in items if item is not None],
                }
            )
    return {
        "project_name": _maybe(project, "GetName") or "",
        "name": _maybe(timeline, "GetName") or "",
        "unique_id": _maybe(timeline, "GetUniqueId") or "",
        "start_frame": _maybe(timeline, "GetStartFrame"),
        "frame_rate": _frame_rate_label(timeline, project),
        "tracks": tracks,
        "markers": _maybe(timeline, "GetMarkers") or {},
    }


def _snapshot_item(item: Any) -> dict[str, Any]:
    return {
        "unique_id": _maybe(item, "GetUniqueId") or "",
        "name": _maybe(item, "GetName") or "",
        "start": _maybe(item, "GetStart"),
        "end": _maybe(item, "GetEnd"),
        "source_start_frame": _maybe(item, "GetSourceStartFrame"),
        "source_end_frame": _maybe(item, "GetSourceEndFrame"),
        "file_path": _file_path(item),
    }


def _file_path(item: Any) -> str | None:
    pool = _maybe(item, "GetMediaPoolItem")
    if pool is None:
        return None
    value = _maybe(pool, "GetClipProperty", "File Path")
    if not isinstance(value, str):
        return None
    path = value.strip()
    return path or None


def _frame_rate_label(timeline: Any, project: Any) -> str:
    for owner in (timeline, project):
        value = _maybe(owner, "GetSetting", "timelineFrameRate")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _maybe(obj: Any, name: str, *args: Any) -> Any:
    if obj is None:
        return None
    method = getattr(obj, name, None)
    if method is None:
        return None
    return method(*args)


def _display_name(snapshot: dict[str, Any]) -> str:
    timeline_name = str(snapshot.get("name") or "").strip()
    if timeline_name:
        return timeline_name
    project_name = str(snapshot.get("project_name") or "").strip()
    return project_name or "Timeline"


def _timeline_id(snapshot: dict[str, Any], name: str) -> str:
    unique = str(snapshot.get("unique_id") or "").strip()
    if unique:
        return unique
    project = str(snapshot.get("project_name") or "").strip()
    return _slug(project, name)


def _slug(*parts: str) -> str:
    raw = "-".join(part.strip() for part in parts if part and part.strip())
    cleaned: list[str] = []
    dash = False
    for char in raw.casefold():
        if char.isalnum():
            cleaned.append(char)
            dash = False
        elif not dash:
            cleaned.append("-")
            dash = True
    return "".join(cleaned).strip("-") or "timeline"


def _frame_rate(label: Any) -> tuple[int, int]:
    text = _normalize_rate_label(label)
    rate = FRAME_RATES.get(text)
    if rate is None:
        raise ValueError(
            f"Unsupported Resolve timelineFrameRate {label!r}. The read does not guess a timebase."
        )
    return rate


def _normalize_rate_label(label: Any) -> str:
    if isinstance(label, bool) or label is None or str(label).strip() == "":
        raise ValueError("Resolve timeline has no timelineFrameRate setting.")
    text = str(label).strip()
    if "." not in text:
        return text
    whole, frac = text.split(".", 1)
    frac = frac.rstrip("0")
    return whole if not frac else f"{whole}.{frac}"


def _track(track: dict[str, Any], num: int, den: int) -> dict[str, Any]:
    if not isinstance(track, dict):
        raise TypeError("Resolve track must be a dict.")
    track_type = track.get("track_type")
    if track_type not in TRACK_KINDS:
        raise ValueError(f"Unknown Resolve track type {track_type!r}.")
    index = int(track.get("index") or 1)
    kind = TRACK_KINDS[track_type]
    track_id = f"{TRACK_PREFIX[kind]}{index}"
    name = str(track.get("name") or "").strip() or track_id.upper()
    items = _as_list(track.get("items"), "items")
    clips = [
        _clip(item, track_id, position, num, den) for position, item in enumerate(items, start=1)
    ]
    return {
        "id": track_id,
        "kind": kind,
        "name": name,
        "clips": clips,
    }


def _clip(item: dict[str, Any], track_id: str, position: int, num: int, den: int) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise TypeError("Resolve timeline item must be a dict.")
    start, duration = _span(item.get("start"), item.get("end"), item.get("name"))
    source_start, source_duration = _source_span(item, duration)
    clip: dict[str, Any] = {
        "id": _clip_id(item, track_id, position),
        "name": str(item.get("name") or ""),
    }
    file_path = item.get("file_path")
    if isinstance(file_path, str) and file_path.strip():
        clip["mediaRef"] = file_path
    clip["sourceRange"] = _range(source_start, source_duration, num, den)
    clip["timelineRange"] = _range(start, duration, num, den)
    return clip


def _clip_id(item: dict[str, Any], track_id: str, position: int) -> str:
    unique = str(item.get("unique_id") or "").strip()
    return unique or f"{track_id}-{position}"


def _source_span(item: dict[str, Any], timeline_duration: Frame) -> tuple[Frame, Frame]:
    start = item.get("source_start_frame")
    end = item.get("source_end_frame")
    if start is None and end is None:
        return 0, timeline_duration
    return _span(start, end, item.get("name"))


def _markers(raw: Any, num: int, den: int) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        raise TypeError("Resolve markers must be a dict of frame to marker info.")
    ordered = [(_as_number(frame), info) for frame, info in raw.items()]
    ordered.sort(key=lambda pair: pair[0])
    markers = []
    for frame, info in ordered:
        if not isinstance(info, dict):
            raise TypeError("Resolve marker info must be a dict.")
        marker: dict[str, Any] = {
            "id": f"m{frame}",
            "name": str(info.get("name") or ""),
            "time": _time(frame, num, den),
        }
        if info.get("duration") is not None:
            duration = _as_number(info["duration"])
            if duration < 0:
                raise ValueError(f"Marker {info.get('name')!r} has a negative duration.")
            if duration > 0:
                marker["duration"] = _time(duration, num, den)
        marker["kind"] = _marker_kind(info)
        note = info.get("note")
        if isinstance(note, str) and note.strip():
            marker["comment"] = note
        markers.append(marker)
    return markers


def _marker_kind(info: dict[str, Any]) -> str:
    for key in ("name", "color"):
        raw = info.get(key)
        if isinstance(raw, str) and raw.strip().casefold() in CHAIR_MARKER_KINDS:
            return raw.strip().casefold()
    return "user"


def _span(start: Any, end: Any, label: Any) -> tuple[Frame, Frame]:
    start_n = _as_number(start)
    end_n = _as_number(end)
    duration = end_n - start_n
    if isinstance(duration, float) and duration.is_integer():
        duration = int(duration)
    if duration < 0:
        raise ValueError(f"Clip {label!r} ends before it starts ({start_n} to {end_n}).")
    return start_n, duration


def _range(start: Frame, duration: Frame, num: int, den: int) -> dict[str, Any]:
    return {"start": _time(start, num, den), "duration": _time(duration, num, den)}


def _time(value: Any, num: int, den: int) -> dict[str, Frame]:
    return {"value": _as_number(value), "rate": num if den == 1 else num / den}


def _as_number(value: Any) -> Frame:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"Expected a frame number, got {value!r}.")
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            raise ValueError("Expected a frame number, got ''.")
        value = float(text) if any(mark in text for mark in ".eE") else int(text)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    raise ValueError(f"Expected a frame number, got {value!r}.")


def _as_list(value: Any, label: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(f"Resolve {label} must be a list.")
    return value
