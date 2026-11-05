"""Apply cut edits (trim, move, picture clips) onto a NEW timeline dict.

Same shape as apply_sound_items in write.py: pure dict mapping, no
Resolve calls, so tests never launch Studio. The live caller writes the
returned copy with write_timeline under "<name> (cut copy)"; the input
timeline is never mutated.

Frame unit: forward patches speak frames at 24 fps — the same unit the
timeline-IR mirror's applyChangesetItem uses (packages/timeline-ir).
Each rational keeps its own rate while shifting. Ops the copy cannot
express (speed, transitions, effects, sound) skip with a reason, citing
the capability manifest fallback where one exists.
"""

from __future__ import annotations

import copy
from typing import Any

from chair_resolve.manifest import MANIFEST, Manifest

MARKER_KINDS = frozenset({"beat", "hook", "fix", "broll", "user", "range"})


def apply_cut_items(
    timeline: dict[str, Any],
    items: list[dict[str, Any]],
    manifest: Manifest = MANIFEST,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Map cut changeset items onto a NEW timeline dict (the copy).

    trim/move/ripple reshape clips, remove_clip removes them (whole, or
    exactly the span when the patch carries {startFrames, frames} as cut_op
    emits: a head/tail trim at the edges, a split mid-clip), add_clip
    inserts a picture snapshot, add/remove_track and
    add/remove_marker edit the copy's structure. The input timeline is
    never mutated. Returns (copy, report) with per-op counts and skipped
    reasons.
    """
    if not isinstance(timeline, dict):
        raise TypeError("Timeline must be an object.")
    tracks = timeline.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("Timeline has no tracks list.")
    result = copy.deepcopy(timeline)
    result.setdefault("markers", [])
    report: dict[str, Any] = {
        "tracks_added": [],
        "tracks_removed": [],
        "clips_placed": [],
        "clips_removed": [],
        "clips_changed": [],
        "markers_added": [],
        "markers_removed": [],
        "skipped": [],
        "fallbacks": [],
    }
    by_id = {track.get("id"): track for track in result["tracks"] if isinstance(track, dict)}

    def skip(item_id: str, reason: str) -> None:
        report["skipped"].append({"id": item_id, "reason": reason})

    for item in items:
        if not isinstance(item, dict):
            continue
        op = item.get("op")
        item_id = str(item.get("id") or op)
        patch = item.get("patch") if isinstance(item.get("patch"), dict) else {}
        target = item.get("targetId")
        if op == "trim":
            _apply_trim(result, by_id, report, item_id, target, patch, skip)
        elif op == "move":
            _apply_move(result, by_id, report, item_id, target, patch, skip)
        elif op == "ripple":
            _apply_ripple(result, by_id, report, item_id, target, patch, skip)
        elif op == "remove_clip":
            _apply_remove_clip(result, by_id, report, item_id, target, patch, skip)
        elif op == "add_clip":
            _apply_add_clip(by_id, report, item_id, target, patch, skip)
        elif op == "add_track":
            _apply_add_track(result, by_id, report, item_id, patch, manifest, skip)
        elif op == "remove_track":
            _apply_remove_track(result, by_id, report, item_id, target, patch, skip)
        elif op == "add_marker":
            _apply_add_marker(result, report, item_id, patch, skip)
        elif op == "remove_marker":
            _apply_remove_marker(result, report, item_id, target, patch, skip)
        elif op == "set_speed":
            skip(item_id, f"Speed {item_id!r}: {manifest.fallbacks.get('speedChanges', 'skipped')}")
        elif op in ("add_transition", "remove_transition"):
            fallback = manifest.fallbacks.get("transitions", "skipped")
            skip(item_id, f"Transition {item_id!r}: {fallback}")
        elif op in ("add_effect", "remove_effect"):
            skip(item_id, f"the cut writer does not place {op} items; "
                          "pieces apply from the Piece Maker")
        else:
            skip(item_id, f"the cut writer does not place {op} items")
    return result, report


def undo_copy_write(
    project: Any,
    copy_name: str,
    original_name: str,
    delete_copy: bool = False,
) -> dict[str, Any]:
    """Undo a cut apply: the original is current again, and the copy is
    deleted only when delete_copy is true. The original's contents are
    never touched. ValueError for bad names, RuntimeError when Resolve
    refuses."""
    if not isinstance(copy_name, str) or not copy_name.strip():
        raise ValueError("undo needs the copy 'timeline_name'")
    if not isinstance(original_name, str) or not original_name.strip():
        raise ValueError("undo needs the 'original_timeline' to restore")
    if not isinstance(delete_copy, bool):
        raise ValueError("undo 'delete_copy' must be true or false")
    copy_name = copy_name.strip()
    original_name = original_name.strip()
    if delete_copy and copy_name == original_name:
        raise ValueError("undo refuses to delete the original timeline")
    original = _find_timeline(project, original_name)
    if original is None:
        raise RuntimeError(f"Timeline {original_name!r} is not in this project.")
    if not project.SetCurrentTimeline(original):
        raise RuntimeError(f"Resolve would not switch back to {original_name!r}.")
    deleted = False
    if delete_copy:
        copy_obj = _find_timeline(project, copy_name)
        if copy_obj is not None:
            media_pool = project.GetMediaPool()
            delete = (
                getattr(media_pool, "DeleteTimelines", None)
                if media_pool is not None else None
            )
            if not callable(delete):
                raise RuntimeError(
                    "this Resolve cannot delete timelines by script; delete the copy by hand"
                )
            if not delete([copy_obj]):
                raise RuntimeError(f"Resolve would not delete {copy_name!r}.")
            deleted = True
    return {"current_timeline": original_name, "deleted": deleted}


def _find_timeline(project: Any, wanted: str) -> Any | None:
    """One project timeline by name. None when it is not in the project."""
    count = project.GetTimelineCount() or 0
    for index in range(1, count + 1):
        candidate = project.GetTimelineByIndex(index)
        if candidate is not None and candidate.GetName() == wanted:
            return candidate
    return None


def describe_cut_report(report: dict[str, Any]) -> str:
    """One plain line per placed cut fact, for the demo proof."""
    lines = [
        f"clips placed: {len(report.get('clips_placed', []))} "
        f"({', '.join(report.get('clips_placed', [])) or 'none'})",
        f"clips removed: {len(report.get('clips_removed', []))} "
        f"({', '.join(report.get('clips_removed', [])) or 'none'})",
        f"clips changed: {len(report.get('clips_changed', []))} "
        f"({', '.join(report.get('clips_changed', [])) or 'none'})",
        f"markers added: {len(report.get('markers_added', []))} "
        f"({', '.join(report.get('markers_added', [])) or 'none'})",
    ]
    for skipped in report.get("skipped", []):
        lines.append(f"skipped {skipped.get('id')}: {skipped.get('reason')}")
    for fallback in report.get("fallbacks", []):
        lines.append(f"fallback {fallback.get('id')}: {fallback.get('reason')}")
    return "\n".join(lines)


def _frames24(time: Any) -> float | None:
    """Timestamp as 24 fps frames. None when it is not a rational time."""
    if not isinstance(time, dict):
        return None
    value, rate = time.get("value"), time.get("rate")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        return None
    return (float(value) / float(rate)) * 24.0


def _shifted(time: dict[str, Any], frames: float) -> dict[str, Any]:
    """Shift a rational timestamp by 24 fps frames, keeping its rate."""
    return {"value": time["value"] + frames * (time["rate"] / 24), "rate": time["rate"]}


def _find_clip(
    tracks: list[Any], clip_id: str
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for track in tracks:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips", []) or []:
            if isinstance(clip, dict) and clip.get("id") == clip_id:
                return track, clip
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _trim_clip(clip: dict[str, Any], head: float, tail: float) -> None:
    """Mirror the timeline-IR trim: head moves both starts, both ends shrink."""
    if head > 0:
        clip["timelineRange"]["start"] = _shifted(clip["timelineRange"]["start"], head)
        clip["sourceRange"]["start"] = _shifted(clip["sourceRange"]["start"], head)
        clip["timelineRange"]["duration"] = _shifted(clip["timelineRange"]["duration"], -head)
        clip["sourceRange"]["duration"] = _shifted(clip["sourceRange"]["duration"], -head)
    if tail > 0:
        clip["timelineRange"]["duration"] = _shifted(clip["timelineRange"]["duration"], -tail)
        clip["sourceRange"]["duration"] = _shifted(clip["sourceRange"]["duration"], -tail)
    for key in ("timelineRange", "sourceRange"):
        if clip[key]["duration"]["value"] < 0:
            clip[key]["duration"]["value"] = 0


def _clip_span_frames(clip: dict[str, Any]) -> float | None:
    try:
        return _frames24(clip["timelineRange"]["duration"])
    except (KeyError, TypeError):
        return None


def _fresh_clip_id(result: dict[str, Any], base: str) -> str:
    """A clip id not yet on the copy, for the second half of a split."""
    taken = {
        clip.get("id")
        for track in result.get("tracks", []) or []
        if isinstance(track, dict)
        for clip in track.get("clips", []) or []
        if isinstance(clip, dict)
    }
    candidate = f"{base}-cut"
    suffix = 2
    while candidate in taken:
        candidate = f"{base}-cut-{suffix}"
        suffix += 1
    return candidate


def _apply_trim(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    del by_id
    found = _find_clip(result["tracks"], target) if isinstance(target, str) else None
    if found is None:
        skip(item_id, f"Trim {item_id!r} names no clip on the copy.")
        return
    head = _number(patch.get("trimStartFrames")) or 0.0
    tail = _number(patch.get("trimEndFrames")) or 0.0
    if head <= 0 and tail <= 0:
        edge_frames = _number(patch.get("frames")) or 0.0
        if edge_frames > 0:
            if patch.get("edge") == "tail":
                tail = edge_frames
            else:
                head = edge_frames
    if head < 0 or tail < 0 or (head <= 0 and tail <= 0):
        skip(item_id, f"Trim {item_id!r} carries no trim amount.")
        return
    span = _clip_span_frames(found[1])
    if span is None:
        skip(item_id, f"Trim {item_id!r} names a clip with no duration.")
        return
    if head + tail >= span:
        skip(item_id, f"Trim {item_id!r} trims the whole clip away.")
        return
    _trim_clip(found[1], head, tail)
    report["clips_changed"].append(found[1].get("id"))


def _apply_move(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    found = _find_clip(result["tracks"], target) if isinstance(target, str) else None
    if found is None:
        skip(item_id, f"Move {item_id!r} names no clip on the copy.")
        return
    track, clip = found
    to_track_id = patch.get("toTrackId")
    to_track = by_id.get(to_track_id) if isinstance(to_track_id, str) and to_track_id else track
    if to_track is None:
        skip(item_id, f"Move {item_id!r} names no track on the copy.")
        return
    if to_track.get("kind") not in ("video", "audio"):
        skip(item_id, f"Move {item_id!r} names a track scripting cannot place.")
        return
    start_value = _number(patch.get("startValue"))
    start_rate = _number(patch.get("startRate"))
    start_frames = _number(patch.get("startFrames"))
    if start_value is not None and start_rate is not None and start_rate > 0:
        if start_value < 0:
            skip(item_id, f"Move {item_id!r} starts before zero.")
            return
        clip["timelineRange"]["start"] = {"value": start_value, "rate": start_rate}
    elif start_frames is not None:
        if start_frames < 0:
            skip(item_id, f"Move {item_id!r} starts before zero.")
            return
        clip["timelineRange"]["start"] = {"value": start_frames, "rate": 24}
    if to_track.get("id") != track.get("id"):
        track["clips"] = [c for c in track.get("clips", []) if c.get("id") != clip.get("id")]
        insert_at = _number(patch.get("insertAt"))
        dest = to_track.setdefault("clips", [])
        if insert_at is not None:
            dest.insert(max(0, min(int(insert_at), len(dest))), clip)
        else:
            dest.append(clip)
    report["clips_changed"].append(clip.get("id"))


def _apply_ripple(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    del by_id
    shift = _number(patch.get("shiftFrames"))
    found = _find_clip(result["tracks"], target) if isinstance(target, str) else None
    if found is None:
        skip(item_id, f"Ripple {item_id!r} names no clip on the copy.")
        return
    if shift is None or shift == 0:
        skip(item_id, f"Ripple {item_id!r} carries no shift.")
        return
    track, clip = found
    anchor = _frames24(clip["timelineRange"]["start"])
    if anchor is None:
        skip(item_id, f"Ripple {item_id!r} names a clip with no start.")
        return
    movers = []
    for entry in track.get("clips", []) or []:
        if not isinstance(entry, dict):
            continue
        start = _frames24(entry.get("timelineRange", {}).get("start"))
        if start is not None and start >= anchor:
            movers.append(entry)
    for entry in movers:
        moved = _shifted(entry["timelineRange"]["start"], shift)
        if moved["value"] < 0:
            skip(item_id, f"Ripple {item_id!r} pushes a clip before zero.")
            return
    for entry in movers:
        entry["timelineRange"]["start"] = _shifted(entry["timelineRange"]["start"], shift)
    report["clips_changed"].append(clip.get("id"))


def _apply_remove_clip(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    del by_id
    found = _find_clip(result["tracks"], target) if isinstance(target, str) else None
    if found is None:
        skip(item_id, f"Remove {item_id!r} names no clip on the copy.")
        return
    track, clip = found
    frames = _number(patch.get("frames"))
    if frames is not None and frames > 0:
        start_frames = _number(patch.get("startFrames")) or 0.0
        span = _clip_span_frames(clip)
        if span is None:
            skip(item_id, f"Cut {item_id!r} names a clip with no duration.")
            return
        cut_start = max(start_frames, 0.0)
        cut_end = min(start_frames + frames, span)
        if cut_start >= span or cut_end <= 0.0:
            skip(item_id, f"Cut {item_id!r} falls outside the clip.")
            return
        if cut_start <= 0.0 and cut_end >= span:
            skip(item_id, f"Cut {item_id!r} cuts the whole clip away.")
            return
        if cut_start <= 0.0:
            _trim_clip(clip, cut_end, 0.0)
            report["clips_changed"].append(clip.get("id"))
            return
        if cut_end >= span:
            _trim_clip(clip, 0.0, span - cut_start)
            report["clips_changed"].append(clip.get("id"))
            return
        second = copy.deepcopy(clip)
        _trim_clip(clip, 0.0, span - cut_start)
        _trim_clip(second, cut_end, 0.0)
        second["id"] = _fresh_clip_id(result, str(clip.get("id")))
        clips = track.get("clips") or []
        at = next(i for i, entry in enumerate(clips) if entry is clip)
        clips.insert(at + 1, second)
        report["clips_changed"].append(clip.get("id"))
        report["clips_changed"].append(second["id"])
        return
    track["clips"] = [c for c in track.get("clips", []) if c.get("id") != clip.get("id")]
    report["clips_removed"].append(clip.get("id"))


def _apply_add_clip(
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    track = by_id.get(target) if isinstance(target, str) else None
    if track is None:
        skip(item_id, f"Insert {item_id!r} names no track on the copy.")
        return
    if track.get("kind") == "audio" or (isinstance(patch.get("kind"), str) and patch.get("kind")):
        skip(item_id, f"the cut writer does not place sound clips (see {item_id!r})")
        return
    if track.get("kind") != "video":
        skip(item_id, f"Insert {item_id!r} names a track scripting cannot place.")
        return
    clip = patch.get("clip") if isinstance(patch.get("clip"), dict) else None
    if clip is None or not clip.get("id"):
        skip(item_id, f"Insert {item_id!r} has no clip snapshot to place.")
        return
    for key in ("sourceRange", "timelineRange"):
        if _frames24((clip.get(key) or {}).get("start")) is None or _frames24(
            (clip.get(key) or {}).get("duration")
        ) is None:
            skip(item_id, f"Insert {item_id!r} has no {key} to place.")
            return
    if not isinstance(clip.get("mediaRef"), str) or not clip["mediaRef"].strip():
        skip(item_id, f"Insert {item_id!r} has no mediaRef file to place.")
        return
    existing = track.setdefault("clips", [])
    if any(c.get("id") == clip["id"] for c in existing):
        skip(item_id, f"Insert {item_id!r} is already on the copy.")
        return
    snapshot = {
        "id": str(clip["id"]),
        "name": str(clip.get("name") or clip["id"]),
        "mediaRef": clip["mediaRef"].strip(),
        "sourceRange": copy.deepcopy(clip["sourceRange"]),
        "timelineRange": copy.deepcopy(clip["timelineRange"]),
    }
    if isinstance(clip.get("effects"), list):
        snapshot["effects"] = copy.deepcopy(clip["effects"])
    if isinstance(clip.get("metadata"), dict):
        snapshot["metadata"] = copy.deepcopy(clip["metadata"])
    existing.append(snapshot)
    existing.sort(key=lambda c: _frames24(c["timelineRange"]["start"]) or 0.0)
    report["clips_placed"].append(snapshot["id"])


def _apply_add_track(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    patch: dict[str, Any],
    manifest: Manifest,
    skip: Any,
) -> None:
    snapshot = patch.get("track") if isinstance(patch.get("track"), dict) else {}
    track_id = str(snapshot.get("id") or patch.get("trackId") or "")
    kind = snapshot.get("kind") or patch.get("kind") or "video"
    if not track_id:
        skip(item_id, f"Track {item_id!r} names no track to add.")
        return
    if track_id in by_id:
        skip(item_id, f"Track {track_id!r} is already on the copy.")
        return
    if kind == "audio":
        skip(item_id, "the cut writer does not place sound tracks")
        return
    if kind in ("subtitle", "effect"):
        key = "subtitles" if kind == "subtitle" else "adjustmentLayers"
        fallback = manifest.fallbacks.get(key, "skipped")
        skip(item_id, f"{kind.title()} track {track_id!r}: {fallback}")
        return
    if kind != "video":
        skip(item_id, f"Track {track_id!r} has unknown kind {kind!r}.")
        return
    entry = {
        "id": track_id,
        "kind": "video",
        "name": str(snapshot.get("name") or patch.get("name") or track_id),
        "clips": copy.deepcopy(snapshot.get("clips") or []),
    }
    result["tracks"].append(entry)
    by_id[track_id] = entry
    report["tracks_added"].append(track_id)


def _apply_remove_track(
    result: dict[str, Any],
    by_id: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    snapshot = patch.get("track") if isinstance(patch.get("track"), dict) else {}
    track_id = target if isinstance(target, str) and target else None
    track_id = track_id or patch.get("trackId") or snapshot.get("id")
    if not isinstance(track_id, str) or not track_id:
        skip(item_id, f"Remove track {item_id!r} names no track.")
        return
    if track_id not in by_id:
        skip(item_id, f"Remove track {item_id!r} names no track on the copy.")
        return
    result["tracks"] = [t for t in result["tracks"] if t.get("id") != track_id]
    del by_id[track_id]
    report["tracks_removed"].append(track_id)


def _apply_add_marker(
    result: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    marker = patch.get("marker") if isinstance(patch.get("marker"), dict) else None
    if marker is None or not marker.get("id"):
        skip(item_id, f"Marker {item_id!r} has no marker to place.")
        return
    marker_id = str(marker["id"])
    if any(m.get("id") == marker_id for m in result["markers"]):
        skip(item_id, f"Marker {marker_id!r} is already on the copy.")
        return
    kind = marker.get("kind")
    if kind not in MARKER_KINDS:
        skip(item_id, f"Marker {marker_id!r} has unknown kind {kind!r}.")
        return
    frames = _frames24(marker.get("time"))
    if frames is None or frames < 0 or not float(frames).is_integer():
        skip(item_id, f"Marker {marker_id!r} is not on a whole frame.")
        return
    entry: dict[str, Any] = {
        "id": marker_id,
        "name": str(marker.get("name") or marker_id),
        "time": copy.deepcopy(marker["time"]),
        "kind": kind,
    }
    for extra in ("comment", "beatId"):
        if marker.get(extra):
            entry[extra] = marker[extra]
    result["markers"].append(entry)
    result["markers"].sort(key=lambda m: _frames24(m["time"]) or 0.0)
    report["markers_added"].append(marker_id)


def _apply_remove_marker(
    result: dict[str, Any],
    report: dict[str, Any],
    item_id: str,
    target: Any,
    patch: dict[str, Any],
    skip: Any,
) -> None:
    snapshot = patch.get("marker") if isinstance(patch.get("marker"), dict) else {}
    marker_id = target if isinstance(target, str) and target else None
    marker_id = marker_id or patch.get("markerId") or snapshot.get("id")
    if not isinstance(marker_id, str) or not marker_id:
        skip(item_id, f"Remove marker {item_id!r} names no marker.")
        return
    if not any(m.get("id") == marker_id for m in result["markers"]):
        skip(item_id, f"Remove marker {item_id!r} names no marker on the copy.")
        return
    result["markers"] = [m for m in result["markers"] if m.get("id") != marker_id]
    report["markers_removed"].append(marker_id)
