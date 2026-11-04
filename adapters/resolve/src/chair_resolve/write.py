"""Write schemas/timeline.schema.json to a new Resolve Studio timeline.

The planner only builds plain dicts, so tests never launch Resolve. The live
caller creates a new timeline; existing timelines are not modified, so a
pending proposed edit cannot change the cut through this path.

Conventions follow the Studio stubs and shipped example 7 (AppendToTimeline
endFrame is inclusive: frames 0..23 are 24 frames). Scripting cannot place
subtitle or effect tracks or retime clips, so the planner cites the
capability manifest fallback. Start timecode is not retimed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chair_resolve.fusion import chair_cache_dir, spec_to_comp
from chair_resolve.manifest import MANIFEST, Manifest
from chair_resolve.ograf import install_ograf, place_ograf_title
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


def import_media(path: str, resolve: Any = None) -> Any:
    """Import one file into the open Studio project's media pool.

    The one editor write the asset shelf may make, on the explicit user
    Import action. Returns the pool item Studio created for the file.
    """
    app = resolve if resolve is not None else resolve_app()
    manager = app.GetProjectManager()
    project = manager.GetCurrentProject() if manager is not None else None
    if project is None:
        raise ResolveClosedError(
            "Resolve Studio has no project open. Open a project and try again."
        )
    # Plain paths: the {"FilePath": ...} dict form answers None on Studio 21.
    imported = project.GetMediaPool().ImportMedia([path])
    if not imported or imported[0] is None:
        raise RuntimeError(f"Studio could not import media {path!r}.")
    return imported[0]


def plan_from_timeline(timeline: dict[str, Any], manifest: Manifest = MANIFEST) -> dict[str, Any]:
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
        "ograf_titles": [],
        "skipped": [],
    }
    counts = {"video": 0, "audio": 0}
    for track in tracks:
        _plan_track(plan, manifest, track, counts, num, den)
    return plan


def write_timeline(
    timeline: dict[str, Any],
    manifest: Manifest = MANIFEST,
    resolve: Any = None,
    fusion_cache_dir: Any = None,
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
        raise RuntimeError(f"Studio could not set current timeline to {plan['timeline_name']!r}.")
    timeline_obj.SetSettings({"timelineFrameRate": plan["frame_rate"]})

    items_by_path: dict[str, Any] = {}
    for path in dict.fromkeys(clip["media_path"] for clip in plan["clips"]):
        items_by_path[path] = import_media(path, app)
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
    imported = 0
    for fusion in plan["fusion"]:
        item = by_clip[fusion["clip_id"]]
        if _import_planned_fusion(plan, manifest, item, fusion, fusion_cache_dir):
            imported += 1
    for ograf in plan["ograf_titles"]:
        _write_ograf_title(ograf, timeline_obj, plan, manifest)
    summary = {
        "timeline": plan["timeline_name"],
        "tracks": len(plan["tracks"]),
        "clips": len(plan["clips"]),
        "markers": len(plan["markers"]),
        "fusion": imported,
        "skipped": len(plan["skipped"]),
    }
    if plan["ograf_titles"]:
        summary["ograf"] = len(plan["ograf_titles"])
    return summary


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
    if span != source_span:
        fallback = manifest.fallbacks.get("speedChanges", "retime the clip in Studio by hand")
        plan["skipped"].append(
            {
                "kind": "clip",
                "id": clip_id,
                "reason": f"{label}: {fallback}",
            }
        )
    for effect in clip.get("effects") or []:
        _plan_effect(plan, manifest, clip_id, effect)
    return {
        "clip_id": clip_id,
        "name": str(clip["name"]),
        "media_path": media.strip(),
        "start_frame": source_start,
        "end_frame": source_start + span - 1,
        "track_type": kind,
        "track_index": index,
        "record_frame": record,
        "media_type": MEDIA_TYPE[kind],
    }


def load_effect_spec(entry: dict[str, Any]) -> dict[str, Any]:
    """Resolve a planned effect-spec entry: inline spec, or specRef JSON file."""
    if "spec" in entry:
        spec = entry["spec"]
        if not isinstance(spec, dict):
            raise ValueError(
                f"Effect {entry.get('effect_id')!r} has an inline spec that is not an object."
            )
        return spec
    ref = entry.get("spec_ref", "")
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError(f"Effect {entry.get('effect_id')!r} needs a specRef file path.")
    path = Path(ref.strip())
    if not path.is_file():
        raise RuntimeError(f"Effect {entry.get('effect_id')!r} specRef is missing: {path}.")
    try:
        spec = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"Effect {entry.get('effect_id')!r} specRef is unreadable: {exc}."
        ) from exc
    if not isinstance(spec, dict):
        raise RuntimeError(f"Effect {entry.get('effect_id')!r} specRef is not an object.")
    return spec


def _resolve_effect_spec(entry: dict[str, Any]) -> dict[str, Any]:
    return load_effect_spec(entry)


def _current_comp_name(item: Any, names: list[str]) -> str | None:
    current = getattr(item, "GetCurrentFusionComp", lambda: None)()
    if current is not None:
        attrs = getattr(current, "GetAttrs", lambda: {})()
        if isinstance(attrs, dict) and attrs.get("COMPS_Name"):
            return str(attrs["COMPS_Name"])
    return names[-1] if names else None


def add_effect(
    item: Any,
    spec: dict[str, Any],
    *,
    cache_dir: Any = None,
    baked: dict[str, dict[str, list[dict[str, Any]]]] | None = None,
    media: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Import an effect spec onto a timeline item as a NEW Fusion comp version.

    The comp text goes to Chair's cache folder, never next to source media.
    ImportFusionComp leaves the previous comp version untouched, so the
    returned op record carries the previous comp name: pass it to
    remove_effect to switch back (the undo the history needs).
    A spec the macro node set cannot express is NOT faked: the return is
    {"effect_id", "fallback": {...}} and nothing is imported.
    """
    rendered = spec_to_comp(spec, baked=baked, media=media)
    if "fallback" in rendered:
        return {"effect_id": spec.get("id"), "fallback": rendered["fallback"]}
    target = cache_dir if cache_dir is not None else chair_cache_dir()
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    comp_path = target / f"chair_{spec.get('id', 'effect')}.comp"
    comp_path.write_text(rendered["text"])
    before = list(getattr(item, "GetFusionCompNameList", lambda: [])() or [])
    prev = _current_comp_name(item, before)
    imported = item.ImportFusionComp(str(comp_path))
    if not imported:
        raise RuntimeError(f"Studio did not import Fusion comp {comp_path}.")
    after = list(getattr(item, "GetFusionCompNameList", lambda: [])() or [])
    added = [name for name in after if name not in before]
    comp_name = added[-1] if added else (after[-1] if after else None)
    return {
        "effect_id": spec.get("id"),
        "comp_path": str(comp_path),
        "comp_name": comp_name,
        "prev_comp_name": prev,
        "undo": {"prev_comp_name": prev},
    }


def _import_planned_fusion(
    plan: dict[str, Any],
    manifest: Manifest,
    item: Any,
    fusion: dict[str, Any],
    cache_dir: Any = None,
) -> bool:
    """Import one planned fusion entry. False when it fell back to skipped."""
    if "comp_path" in fusion:
        item.ImportFusionComp(fusion["comp_path"])
        return True
    op = add_effect(item, _resolve_effect_spec(fusion), cache_dir=cache_dir)
    if "fallback" in op:
        fallback = manifest.fallbacks.get("fusionMacros", "rendered clip instead")
        plan["skipped"].append(
            {
                "kind": "effect",
                "id": fusion["effect_id"],
                "reason": f"Effect {fusion['effect_id']!r} ({fusion['preset']!r}): {fallback}",
            }
        )
        return False
    return True


def remove_effect(item: Any, op: dict[str, Any]) -> bool:
    """Undo add_effect: switch the item back to its previous comp version."""
    if "fallback" in op:
        return True
    undo = op.get("undo") or {}
    prev = undo.get("prev_comp_name", op.get("prev_comp_name"))
    if not prev:
        return False
    loader = getattr(item, "LoadFusionCompByName", None)
    if loader is None:
        return False
    return bool(loader(prev))


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
    export_target = effect.get("exportTarget")
    if not isinstance(export_target, str):
        export_target = params.get("exportTarget")
    if export_target == "ograf":
        _plan_ograf_effect(plan, manifest, clip_id, effect_id, effect, params)
        return
    if "spec" in params or "specRef" in params:
        if not manifest.capabilities.fusion_macros:
            fallback = manifest.fallbacks.get("fusionMacros", "Fusion macros are disabled.")
            plan["skipped"].append(
                {
                    "kind": "effect",
                    "id": effect_id,
                    "reason": f"Effect {effect_id!r} ({effect['presetName']!r}): {fallback}",
                }
            )
            return
        inline = params.get("spec")
        ref = params.get("specRef")
        if inline is not None and not isinstance(inline, dict):
            raise ValueError(f"Effect {effect_id!r} needs params.spec, an effect spec object.")
        if inline is None and (not isinstance(ref, str) or not ref.strip()):
            raise ValueError(f"Effect {effect_id!r} needs params.specRef, a spec file path.")
        entry: dict[str, Any] = {
            "clip_id": clip_id,
            "effect_id": effect_id,
            "preset": str(effect["presetName"]),
            "kind": "effect-spec",
        }
        if inline is not None:
            entry["spec"] = inline
        else:
            entry["spec_ref"] = ref.strip()
        plan["fusion"].append(entry)
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


def _plan_ograf_effect(
    plan: dict[str, Any],
    manifest: Manifest,
    clip_id: str,
    effect_id: str,
    effect: dict[str, Any],
    params: dict[str, Any],
) -> None:
    """Record an OGraf title install instead of a Fusion comp import."""
    title_name = params.get("ografTitle")
    if not isinstance(title_name, str) or not title_name.strip():
        title_name = str(effect["presetName"])
    if not manifest.capabilities.ograf_titles:
        fallback = manifest.fallbacks.get("ografTitles", "OGraf titles are disabled.")
        plan["skipped"].append(
            {
                "kind": "effect",
                "id": effect_id,
                "reason": f"Effect {effect_id!r}: {fallback}",
            }
        )
        return
    entry: dict[str, Any] = {
        "clip_id": clip_id,
        "effect_id": effect_id,
        "preset": str(effect["presetName"]),
        "title_name": title_name.strip(),
    }
    bundle_manifest = params.get("ografManifest")
    bundle_js = params.get("ografJs")
    if isinstance(bundle_manifest, dict) and isinstance(bundle_js, str) and bundle_js.strip():
        entry["manifest"] = bundle_manifest
        entry["js"] = bundle_js
    plan["ograf_titles"].append(entry)


def _write_ograf_title(
    entry: dict[str, Any],
    timeline_obj: Any,
    plan: dict[str, Any],
    manifest: Manifest,
) -> None:
    """Install the title bundle, then try scripting placement on the timeline."""
    title_name = str(entry["title_name"])
    bundle_manifest = entry.get("manifest")
    bundle_js = entry.get("js")
    if isinstance(bundle_manifest, dict) and isinstance(bundle_js, str):
        try:
            installed = install_ograf(bundle_manifest, bundle_js)
        except (TypeError, ValueError, OSError) as exc:
            plan["skipped"].append(
                {
                    "kind": "effect",
                    "id": str(entry["effect_id"]),
                    "reason": f"OGraf title {title_name!r}: install failed ({exc}).",
                }
            )
            return
        title_name = str(installed["title_name"])
    if place_ograf_title(timeline_obj, title_name):
        return
    fallback = manifest.fallbacks.get("ografTitles", "OGraf titles need a hand install.")
    plan["skipped"].append(
        {
            "kind": "effect",
            "id": str(entry["effect_id"]),
            "reason": f'OGraf title {title_name!r}: {fallback} (drag "{title_name}" '
            'from Effects > Titles > OGraf onto the timeline)',
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


def apply_sound_items(
    timeline: dict[str, Any],
    items: list[dict[str, Any]],
    manifest: Manifest = MANIFEST,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Map sound changeset items onto a NEW timeline dict (the copy).

    add_track adds the SFX audio track, add_clip places the SFX snapshot on
    it, and set_gain records ducking keyframes on the target clip's metadata
    for Fairlight (scripting cannot set them: see the audioKeyframes
    fallback). The input timeline is never mutated. Returns (copy, report)
    with track/clip/keyframe counts and skipped reasons.
    """
    import copy

    if not isinstance(timeline, dict):
        raise TypeError("Timeline must be an object.")
    tracks = timeline.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("Timeline has no tracks list.")
    result = copy.deepcopy(timeline)
    report: dict[str, Any] = {
        "tracks_added": [],
        "clips_placed": [],
        "keyframes": 0,
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
        if op == "add_track":
            track = patch.get("track") if isinstance(patch.get("track"), dict) else {}
            track_id = str(track.get("id") or patch.get("trackId") or "")
            if track.get("kind", "audio") != "audio" or not track_id:
                continue  # not a sound track; the generic applier owns it
            if track_id in by_id:
                continue
            entry = {
                "id": track_id,
                "kind": "audio",
                "name": str(track.get("name") or "SFX"),
                "clips": list(track.get("clips") or []),
            }
            result["tracks"].append(entry)
            by_id[track_id] = entry
            report["tracks_added"].append(track_id)
        elif op == "add_clip":
            target = item.get("targetId")
            track = by_id.get(target) if isinstance(target, str) else None
            clip = patch.get("clip") if isinstance(patch.get("clip"), dict) else None
            if track is None or track.get("kind") != "audio":
                skip(item_id, f"SFX {item_id!r} names no audio track on the copy.")
                continue
            if clip is None or not clip.get("id"):
                skip(item_id, f"SFX {item_id!r} has no clip snapshot to place.")
                continue
            if manifest.audio_capabilities.get("place_sfx_on_new_track", True) is False:
                skip(item_id, f"SFX {item_id!r}: {manifest.fallbacks.get('placeSfx', 'skipped')}")
                continue
            snapshot = {
                "id": str(clip["id"]),
                "name": str(clip.get("name") or clip["id"]),
                "sourceRange": clip["sourceRange"],
                "timelineRange": clip["timelineRange"],
            }
            if clip.get("mediaRef"):
                snapshot["mediaRef"] = str(clip["mediaRef"])
            snapshot["metadata"] = {
                **(clip.get("metadata") if isinstance(clip.get("metadata"), dict) else {}),
                "chairSound": {
                    "kind": str(patch.get("kind") or "sfx"),
                    "gainDb": patch.get("gainDb"),
                    "license": patch.get("license"),
                },
            }
            existing = track.setdefault("clips", [])
            if not any(c.get("id") == snapshot["id"] for c in existing):
                existing.append(snapshot)
                existing.sort(key=lambda c: _timeline_start(c, item_id))
            report["clips_placed"].append(snapshot["id"])
        elif op == "set_gain":
            target = item.get("targetId")
            found = _find_clip(result["tracks"], target) if isinstance(target, str) else None
            keyframes = patch.get("keyframes")
            if found is None:
                skip(item_id, f"Duck {item_id!r} names no clip on the copy.")
                continue
            if not isinstance(keyframes, list) or not keyframes:
                skip(item_id, f"Duck {item_id!r} carries no keyframes.")
                continue
            if manifest.audio_capabilities.get("volume_keyframes", False) is False:
                found.setdefault("metadata", {})["chairDucking"] = {
                    "gainDb": patch.get("gainDb"),
                    "keyframes": keyframes,
                    "fallback": manifest.fallbacks.get(
                        "audioKeyframes", "set the Fairlight keyframes by hand"
                    ),
                }
                report["keyframes"] += len(keyframes)
                report["fallbacks"].append({
                    "id": item_id,
                    "reason": manifest.fallbacks.get(
                        "audioKeyframes", "set the Fairlight keyframes by hand"
                    ),
                })
                continue
            found.setdefault("metadata", {})["chairDucking"] = {
                "gainDb": patch.get("gainDb"),
                "keyframes": keyframes,
            }
            report["keyframes"] += len(keyframes)
    return result, report


def _timeline_start(clip: dict[str, Any], label: str) -> float:
    try:
        start = clip["timelineRange"]["start"]
        return float(start["value"]) / float(start["rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise ValueError(f"Clip {label!r} has no timeline start.") from error


def _find_clip(tracks: list[Any], clip_id: str) -> dict[str, Any] | None:
    for track in tracks:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips", []) or []:
            if isinstance(clip, dict) and clip.get("id") == clip_id:
                return clip
    return None


def describe_sound_report(report: dict[str, Any]) -> str:
    """One plain line per placed sound fact, for the demo proof."""
    lines = [
        f"audio tracks added: {len(report.get('tracks_added', []))} "
        f"({', '.join(report.get('tracks_added', [])) or 'none'})",
        f"sfx clips placed: {len(report.get('clips_placed', []))} "
        f"({', '.join(report.get('clips_placed', [])) or 'none'})",
        f"volume keyframes: {report.get('keyframes', 0)}",
    ]
    for skipped in report.get("skipped", []):
        lines.append(f"skipped {skipped.get('id')}: {skipped.get('reason')}")
    for fallback in report.get("fallbacks", []):
        lines.append(f"fallback {fallback.get('id')}: {fallback.get('reason')}")
    return "\n".join(lines)


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
