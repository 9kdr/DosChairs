"""Write schemas/timeline.schema.json to a new Resolve Studio timeline.

The planner only builds plain dicts, so tests never launch Resolve. The live
caller creates a new timeline; existing timelines are not modified, so a
pending proposed edit cannot change the cut through this path.

Conventions follow the Studio stubs and shipped example 7 (AppendToTimeline
endFrame is inclusive: frames 0..23 are 24 frames). Scripting cannot place
subtitle or effect tracks, so the planner skips those and cites the
capability manifest fallback. Speed and start timecode are not retimed.
"""

from __future__ import annotations

from typing import Any

from chair_resolve.manifest import MANIFEST, Manifest
from chair_resolve.read import FRAME_RATES, TRACK_PREFIX, ResolveClosedError, resolve_app

Frame = int | float
TRACK_KINDS = frozenset({"video", "audio", "subtitle", "effect"})
MEDIA_TYPE = {"video": 1, "audio": 2}
MARKER_COLORS = {
    "beat": "Yellow",
    "hook": "Green",
    "fix": "Red",
    "broll": "Purple",
    "user": "Blue",
    "range": "Cyan",
}
SKIP_FALLBACK = {"subtitle": "subtitles", "effect": "adjustmentLayers"}
_RATE_LABELS = {rate: label for label, rate in FRAME_RATES.items()}


def plan_from_timeline(
    timeline: dict[str, Any], manifest: Manifest = MANIFEST
) -> dict[str, Any]:
    """Plan Studio scripting calls for a Chair timeline, as plain dicts."""
    if not isinstance(timeline, dict):
        raise TypeError("Timeline must be an object.")
    for key in ("id", "name", "rate", "tracks", "markers"):
        if key not in timeline:
            raise ValueError(f"Timeline is missing {key}.")
    num, den = _rate_pair(timeline["rate"])
    tracks = timeline["tracks"]
    if not isinstance(tracks, list):
        raise TypeError("Timeline tracks must be a list.")
    markers = timeline["markers"]
    if not isinstance(markers, list):
        raise TypeError("Timeline markers must be a list.")
    plan: dict[str, Any] = {
        "timeline_name": str(timeline["name"]).strip() or str(timeline["id"]),
        "frame_rate": _rate_label(num, den),
        "rate": {"num": num, "den": den},
        "tracks": [],
        "clips": [],
        "markers": _plan_markers(markers, num, den),
        "fusion": [],
        "skipped": [],
    }
    counts = {"video": 0, "audio": 0}
    for track in tracks:
        _plan_track(plan, manifest, track, counts, num, den)
    return plan


def write_timeline(
    timeline: dict[str, Any], manifest: Manifest = MANIFEST, resolve: Any = None
) -> dict[str, Any]:
    """Create a new Studio timeline from Chair IR. Returns counts, not objects."""
    plan = plan_from_timeline(timeline, manifest)
    app = resolve if resolve is not None else resolve_app()
    manager = app.GetProjectManager()
    project = manager.GetCurrentProject() if manager is not None else None
    if project is None:
        raise ResolveClosedError(
            "Resolve Studio has no project open. Open a project and try again."
        )
    media_pool = project.GetMediaPool()

    timeline_obj = media_pool.CreateEmptyTimeline(plan["timeline_name"])
    if not timeline_obj:
        raise RuntimeError(
            f"Studio could not create timeline {plan['timeline_name']!r}: "
            "a timeline with that name already exists."
        )
    if not project.SetCurrentTimeline(timeline_obj):
        raise RuntimeError(
            f"Studio could not set current timeline to {plan['timeline_name']!r}."
        )
    timeline_obj.SetSettings({"timelineFrameRate": plan["frame_rate"]})

    items_by_path: dict[str, Any] = {}
    for path in dict.fromkeys(clip["media_path"] for clip in plan["clips"]):
        imported = media_pool.ImportMedia([{"FilePath": path}])
        if not imported or imported[0] is None:
            raise RuntimeError(f"Studio could not import media {path!r}.")
        items_by_path[path] = imported[0]
    for track in plan["tracks"]:
        while timeline_obj.GetTrackCount(track["track_type"]) < track["index"]:
            timeline_obj.AddTrack(track["track_type"])
        timeline_obj.SetTrackName(track["track_type"], track["index"], track["name"])

    clip_infos = [
        {
            "mediaPoolItem": items_by_path[clip["media_path"]],
            "startFrame": clip["start_frame"],
            "endFrame": clip["end_frame"],
            "mediaType": clip["media_type"],
            "trackIndex": clip["track_index"],
            "recordFrame": clip["record_frame"],
        }
        for clip in plan["clips"]
    ]
    placed = media_pool.AppendToTimeline(clip_infos) if clip_infos else []
    if len(placed) != len(clip_infos):
        raise RuntimeError("Studio did not place every planned clip.")
    by_clip = {clip["clip_id"]: item for clip, item in zip(plan["clips"], placed, strict=True)}

    for marker in plan["markers"]:
        timeline_obj.AddMarker(
            marker["frame"],
            marker["color"],
            marker["name"],
            marker["note"],
            marker["duration"],
            marker["custom_data"],
        )
    for fusion in plan["fusion"]:
        by_clip[fusion["clip_id"]].ImportFusionComp(fusion["comp_path"])
    return {
        "timeline": plan["timeline_name"],
        "tracks": len(plan["tracks"]),
        "clips": len(plan["clips"]),
        "markers": len(plan["markers"]),
        "fusion": len(plan["fusion"]),
        "skipped": len(plan["skipped"]),
    }


def _plan_track(
    plan: dict[str, Any],
    manifest: Manifest,
    track: Any,
    counts: dict[str, int],
    num: int,
    den: int,
) -> None:
    if not isinstance(track, dict):
        raise TypeError("Track must be an object.")
    kind = track.get("kind")
    if kind not in TRACK_KINDS:
        raise ValueError(f"Unknown track kind {kind!r}.")
    track_id = str(track.get("id") or "")
    if kind in SKIP_FALLBACK:
        fallback = manifest.fallbacks.get(SKIP_FALLBACK[kind], "skipped")
        reason = f"{kind.title()} track {track_id!r}: {fallback}"
        plan["skipped"].append({"kind": "track", "id": track_id, "reason": reason})
        return
    counts[kind] += 1
    index = counts[kind]
    name = str(track.get("name") or "").strip() or f"{TRACK_PREFIX[kind]}{index}".upper()
    plan["tracks"].append({"track_type": kind, "index": index, "name": name})
    clips = track.get("clips")
    if not isinstance(clips, list):
        raise TypeError(f"Track {track_id!r} clips must be a list.")
    entries = [_plan_clip(plan, manifest, clip, kind, index, track_id, num, den) for clip in clips]
    entries = [entry for entry in entries if entry is not None]
    entries.sort(key=lambda entry: entry["record_frame"])
    plan["clips"].extend(entries)


def _plan_clip(
    plan: dict[str, Any],
    manifest: Manifest,
    clip: Any,
    kind: str,
    index: int,
    track_id: str,
    num: int,
    den: int,
) -> dict[str, Any] | None:
    if not isinstance(clip, dict):
        raise TypeError("Clip must be an object.")
    for key in ("id", "name", "sourceRange", "timelineRange"):
        if key not in clip:
            raise ValueError(f"Clip is missing {key}.")
    clip_id = str(clip["id"])
    label = f"Clip {clip_id!r}"
    source_start = _frames(clip["sourceRange"], num, den, f"{label} source start", "start")
    source_span = _frames(clip["sourceRange"], num, den, f"{label} source duration", "duration")
    record = _frames(clip["timelineRange"], num, den, f"{label} timeline start", "start")
    span = _frames(clip["timelineRange"], num, den, f"{label} timeline duration", "duration")
    if source_span <= 0:
        raise ValueError(f"{label} has no source duration.")
    if span <= 0:
        raise ValueError(f"{label} has no timeline duration.")
    if source_start < 0 or record < 0:
        raise ValueError(f"{label} starts before zero.")
    media = clip.get("mediaRef")
    if not isinstance(media, str) or not media.strip():
        plan["skipped"].append(
            {
                "kind": "clip",
                "id": clip_id,
                "reason": f"{label} on track {track_id!r} has no mediaRef.",
            }
        )
        return None
    for effect in clip.get("effects") or []:
        _plan_effect(plan, manifest, clip_id, effect)
    return {
        "clip_id": clip_id,
        "name": str(clip["name"]),
        "media_path": media.strip(),
        "start_frame": source_start,
        "end_frame": source_start + source_span - 1,
        "track_type": kind,
        "track_index": index,
        "record_frame": record,
        "media_type": MEDIA_TYPE[kind],
    }


def _plan_effect(plan: dict[str, Any], manifest: Manifest, clip_id: str, effect: Any) -> None:
    if not isinstance(effect, dict):
        raise TypeError("Effect must be an object.")
    for key in ("id", "presetName", "params"):
        if key not in effect:
            raise ValueError(f"Effect is missing {key}.")
    params = effect["params"]
    if not isinstance(params, dict):
        raise TypeError("Effect params must be an object.")
    effect_id = str(effect["id"])
    enabled = effect.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError(f"Effect {effect_id!r} enabled must be a boolean.")
    if not enabled:
        plan["skipped"].append(
            {"kind": "effect", "id": effect_id, "reason": f"Effect {effect_id!r} is disabled."}
        )
        return
    if not manifest.capabilities.fusion_comps:
        fallback = manifest.fallbacks.get("fusionComps", "Fusion comps are disabled.")
        plan["skipped"].append(
            {
                "kind": "effect",
                "id": effect_id,
                "reason": f"Effect {effect_id!r} ({effect['presetName']!r}): {fallback}",
            }
        )
        return
    comp_path = params.get("compPath")
    if not isinstance(comp_path, str) or not comp_path.strip():
        raise ValueError(
            f"Effect {effect_id!r} needs params.compPath, a Fusion .comp file to import."
        )
    plan["fusion"].append(
        {
            "clip_id": clip_id,
            "effect_id": effect_id,
            "preset": str(effect["presetName"]),
            "comp_path": comp_path.strip(),
        }
    )


def _plan_markers(markers: list[Any], num: int, den: int) -> list[dict[str, Any]]:
    planned = []
    for marker in markers:
        if not isinstance(marker, dict):
            raise TypeError("Marker must be an object.")
        for key in ("id", "name", "time", "kind"):
            if key not in marker:
                raise ValueError(f"Marker is missing {key}.")
        kind = marker["kind"]
        if kind not in MARKER_COLORS:
            raise ValueError(f"Marker kind {kind!r} is not a Chair marker.")
        label = f"Marker {marker['id']!r}"
        frame = _frames(marker["time"], num, den, label, part=None)
        if isinstance(frame, float):
            raise ValueError(f"{label} is not on a whole frame.")
        duration: Frame = 0
        if marker.get("duration") is not None:
            duration = _frames(marker["duration"], num, den, f"{label} duration", part=None)
            if isinstance(duration, float) or duration < 0:
                raise ValueError(f"{label} duration is not whole frames.")
        planned.append(
            {
                "frame": frame,
                "color": MARKER_COLORS[kind],
                "name": str(marker["name"]),
                "note": str(marker.get("comment") or ""),
                "duration": duration,
                "custom_data": kind,
            }
        )
    planned.sort(key=lambda marker: marker["frame"])
    return planned


def _rate_pair(rate: Any) -> tuple[int, int]:
    if not isinstance(rate, dict):
        raise TypeError("Timeline rate must be an object.")
    num = rate.get("num")
    den = rate.get("den")
    if type(num) is not int or type(den) is not int or num < 1 or den < 1:
        raise ValueError("Timeline rate must be positive integers.")
    return num, den


def _rate_label(num: int, den: int) -> str:
    label = _RATE_LABELS.get((num, den))
    if label is None:
        raise ValueError(f"Timeline rate {num}/{den} is not a Resolve timelineFrameRate.")
    return label


def _frames(node: Any, num: int, den: int, label: str, part: str | None) -> Frame:
    rational: Any = node if part is None else node.get(part) if isinstance(node, dict) else None
    if not isinstance(rational, dict) or "value" not in rational or "rate" not in rational:
        raise ValueError(f"{label} must be a rational time.")
    value = rational["value"]
    rate = rational["rate"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} value must be a frame number.")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError(f"{label} rate must be a positive number.")
    frames = float(value) * (num / den) / rate
    return int(frames) if frames.is_integer() else frames
