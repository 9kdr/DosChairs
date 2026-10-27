"""Read and write a Kdenlive project as schemas/timeline.schema.json.

Kdenlive stores the cut in MLT XML. The sequence is a tractor, each track is a
tractor of playlists, and guides are a JSON array on the sequence. Fusion comps
are not written; the capability manifest falls back to a pre-rendered overlay.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "0.1.0"
MARKER_KINDS = frozenset({"beat", "hook", "fix", "broll", "user", "range"})
TRACK_KINDS = frozenset({"video", "audio", "subtitle", "effect"})
TRACK_PREFIX = {"video": "v", "audio": "a", "subtitle": "s", "effect": "e"}
KIND_TYPE = {"user": 0, "beat": 1, "hook": 2, "fix": 3, "broll": 4, "range": 5}
MEDIA_ELEMENTS = frozenset({"producer", "chain", "playlist", "tractor"})
_SKIP_MEDIA = frozenset({"", "black", "<producer>", "color:black", "0"})


def timeline_from_kdenlive(source: str) -> dict[str, Any]:
    """Read a Kdenlive project XML document, or a path to one, into a Chair timeline."""
    root = _parse(_load(source))
    if root.tag != "mlt":
        raise ValueError("Kdenlive project root must be <mlt>.")
    num, den = _profile_rate(root)
    by_id = _index(root)
    sequence = _active_sequence(root, by_id)
    props = _properties(sequence)
    timeline: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "id": _sequence_id(sequence, props),
        "name": _sequence_name(root, props),
        "rate": {"num": num, "den": den},
        "tracks": _tracks(sequence, by_id, num, den),
        "markers": _markers(_guide_text(sequence, root), num, den),
    }
    story = (props.get("kdenlive:sequenceproperties.chairStoryPlanId") or "").strip()
    style = (props.get("kdenlive:sequenceproperties.chairStyleProfileId") or "").strip()
    if story:
        timeline["storyPlanId"] = story
    if style:
        timeline["styleProfileId"] = style
    global_start = (props.get("kdenlive:sequenceproperties.chairGlobalStart") or "").strip()
    if global_start:
        parsed = json.loads(global_start)
        if not isinstance(parsed, dict):
            raise ValueError("Timeline globalStart must be an object.")
        timeline["globalStart"] = parsed
    return timeline


def kdenlive_from_timeline(timeline: dict[str, Any]) -> str:
    """Write a Chair timeline to a Kdenlive MLT project. The source file is not opened."""
    if not isinstance(timeline, dict):
        raise TypeError("Timeline must be an object.")
    for key in ("id", "name", "rate", "tracks", "markers"):
        if key not in timeline:
            raise ValueError(f"Timeline is missing {key}.")
    num, den = _rate_pair(timeline["rate"])
    timeline_id = str(timeline["id"]).strip()
    if not timeline_id:
        raise ValueError("Timeline id is empty.")
    name = str(timeline["name"])

    root = ET.Element(
        "mlt",
        {"LC_NUMERIC": "C", "version": "7.0.0", "title": name, "producer": "main_bin"},
    )
    ET.SubElement(
        root,
        "profile",
        {
            "description": "HD 1080p",
            "width": "1920",
            "height": "1080",
            "progressive": "1",
            "sample_aspect_num": "1",
            "sample_aspect_den": "1",
            "display_aspect_num": "16",
            "display_aspect_den": "9",
            "frame_rate_num": str(num),
            "frame_rate_den": str(den),
            "colorspace": "709",
        },
    )

    used = {"main_bin", "black_track", "project"}
    sequence_element_id = _fresh_id(_xml_id(timeline_id, "sequence0"), used)
    producers: dict[tuple[str, str], str] = {}
    placeholders: dict[str, str] = {}
    track_elements: list[ET.Element] = []

    black = ET.SubElement(root, "producer", {"id": "black_track"})
    _prop(black, "resource", "black")
    _prop(black, "mlt_service", "color")

    tracks = timeline["tracks"]
    if not isinstance(tracks, list):
        raise TypeError("Timeline tracks must be a list.")
    for track in tracks:
        track_elements.append(
            _write_track(
                root,
                track,
                num,
                den,
                used,
                producers,
                placeholders,
                timeline_id,
            )
        )

    for sequence_id, element_id in placeholders.items():
        _write_placeholder(root, sequence_id, element_id)

    sequence = ET.SubElement(root, "tractor", {"id": sequence_element_id, "title": name})
    _prop(sequence, "kdenlive:uuid", timeline_id)
    _prop(sequence, "kdenlive:clipname", name)
    guides = _guides_json(timeline["markers"], num, den)
    _prop(sequence, "kdenlive:sequenceproperties.guides", guides)
    if timeline.get("storyPlanId"):
        _prop(
            sequence,
            "kdenlive:sequenceproperties.chairStoryPlanId",
            str(timeline["storyPlanId"]),
        )
    if timeline.get("styleProfileId"):
        _prop(
            sequence,
            "kdenlive:sequenceproperties.chairStyleProfileId",
            str(timeline["styleProfileId"]),
        )
    if "globalStart" in timeline:
        _prop(
            sequence,
            "kdenlive:sequenceproperties.chairGlobalStart",
            json.dumps(timeline["globalStart"], separators=(",", ":")),
        )
    ET.SubElement(sequence, "track", {"producer": "black_track"})
    for track in track_elements:
        ET.SubElement(sequence, "track", {"producer": track.get("id") or ""})

    main_bin = ET.SubElement(root, "playlist", {"id": "main_bin"})
    _prop(main_bin, "kdenlive:docproperties.activetimeline", timeline_id)
    _prop(main_bin, "kdenlive:docproperties.uuid", timeline_id)
    _prop(main_bin, "xml_retain", "1")
    ET.SubElement(main_bin, "entry", {"producer": sequence_element_id, "in": "0", "out": "0"})

    project = ET.SubElement(root, "tractor", {"id": "project"})
    _prop(project, "kdenlive:projectTractor", "1")
    ET.SubElement(project, "track", {"producer": sequence_element_id})

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    return "<?xml version='1.0' encoding='utf-8'?>\n" + body


def _load(source: str) -> str:
    if not isinstance(source, str) or source.strip() == "":
        raise ValueError("Kdenlive project source is empty.")
    text = source.lstrip("\ufeff")
    if text.lstrip().startswith("<"):
        return text
    path = Path(source)
    if path.is_file():
        return path.read_text(encoding="utf-8")
    raise ValueError(f"Kdenlive project {source!r} is not XML or a project file.")


def _parse(text: str) -> ET.Element:
    try:
        return ET.fromstring(text)
    except ET.ParseError as exc:
        raise ValueError(f"Kdenlive project XML could not be parsed: {exc}") from exc


def _profile_rate(root: ET.Element) -> tuple[int, int]:
    profile = root.find("profile")
    if profile is None:
        raise ValueError("Kdenlive project has no profile.")
    raw_num = profile.get("frame_rate_num")
    raw_den = profile.get("frame_rate_den")
    if not raw_num or not raw_den:
        raise ValueError("Kdenlive project profile has no frame rate.")
    try:
        num = int(raw_num)
        den = int(raw_den)
    except ValueError as exc:
        raise ValueError("Kdenlive project profile frame rate must be integers.") from exc
    if num < 1 or den < 1:
        raise ValueError("Kdenlive project profile frame rate must be positive.")
    return num, den


def _rate_pair(rate: Any) -> tuple[int, int]:
    if not isinstance(rate, dict):
        raise TypeError("Timeline rate must be an object.")
    num = rate.get("num")
    den = rate.get("den")
    if type(num) is not int or type(den) is not int or num < 1 or den < 1:
        raise ValueError("Timeline rate must be positive integers.")
    return num, den


def _index(root: ET.Element) -> dict[str, ET.Element]:
    found: dict[str, ET.Element] = {}
    for child in root:
        if child.tag not in MEDIA_ELEMENTS:
            continue
        element_id = child.get("id")
        if not element_id:
            continue
        if element_id in found:
            raise ValueError(f"Kdenlive project has two elements with id {element_id!r}.")
        found[element_id] = child
    return found


def _properties(element: ET.Element) -> dict[str, str]:
    found: dict[str, str] = {}
    for child in element:
        if child.tag == "property" and child.get("name"):
            found[child.get("name") or ""] = "" if child.text is None else child.text
    return found


def _doc_properties(root: ET.Element) -> dict[str, str]:
    bin_id = root.get("producer") or "main_bin"
    for child in root:
        if child.tag == "playlist" and child.get("id") == bin_id:
            return _properties(child)
    return {}


def _is_track_tractor(element: ET.Element, by_id: dict[str, ET.Element]) -> bool:
    props = _properties(element)
    if "kdenlive:uuid" in props or any(
        name.startswith("kdenlive:sequenceproperties.") for name in props
    ):
        return False
    if props.get("kdenlive:projectTractor") == "1":
        return False
    links = [child for child in element if child.tag == "track"]
    if not links:
        return False
    for link in links:
        target = by_id.get(link.get("producer") or "")
        if target is None or target.tag != "playlist":
            return False
    return True


def _is_sequence(element: ET.Element | None, by_id: dict[str, ET.Element]) -> bool:
    if element is None or element.tag != "tractor":
        return False
    if _properties(element).get("kdenlive:projectTractor") == "1":
        return False
    if not any(child.tag == "track" for child in element):
        return False
    return not _is_track_tractor(element, by_id)


def _active_sequence(root: ET.Element, by_id: dict[str, ET.Element]) -> ET.Element:
    sequences = [child for child in root if _is_sequence(child, by_id)]
    if not sequences:
        raise ValueError("Kdenlive project has no timeline.")
    doc = _doc_properties(root)
    active = (doc.get("kdenlive:docproperties.activetimeline") or "").strip()
    if active:
        match = _sequence_by_id(sequences, active)
        if match is not None:
            return match
    for child in root:
        if child.tag == "tractor" and _properties(child).get("kdenlive:projectTractor") == "1":
            producer = next(
                (link.get("producer") or "" for link in child if link.tag == "track"), ""
            )
            match = _sequence_by_id(sequences, producer)
            if match is not None:
                return match
    document_uuid = (doc.get("kdenlive:docproperties.uuid") or "").strip()
    if document_uuid:
        match = _sequence_by_id(sequences, document_uuid)
        if match is not None:
            return match
    return sequences[0]


def _sequence_by_id(sequences: list[ET.Element], wanted: str) -> ET.Element | None:
    for sequence in sequences:
        if sequence.get("id") == wanted or _properties(sequence).get("kdenlive:uuid") == wanted:
            return sequence
    return None


def _sequence_id(sequence: ET.Element, props: dict[str, str]) -> str:
    uuid = (props.get("kdenlive:uuid") or "").strip()
    if uuid:
        return uuid
    element_id = (sequence.get("id") or "").strip()
    if element_id:
        return element_id
    raise ValueError("Kdenlive sequence has no id.")


def _sequence_name(root: ET.Element, props: dict[str, str]) -> str:
    name = (props.get("kdenlive:clipname") or "").strip()
    if name:
        return name
    title = (root.get("title") or "").strip()
    return title or "Timeline"


def _is_black(element: ET.Element) -> bool:
    if element.get("id") == "black_track":
        return True
    props = _properties(element)
    if props.get("kdenlive:playlistid") == "black_track":
        return True
    resource = (props.get("resource") or "").strip()
    return props.get("mlt_service") == "color" and resource in {"black", "0", "color:black"}


def _tracks(
    sequence: ET.Element, by_id: dict[str, ET.Element], num: int, den: int
) -> list[dict[str, Any]]:
    tracks = []
    counts = dict.fromkeys(TRACK_KINDS, 0)
    for link in sequence:
        if link.tag != "track":
            continue
        producer_id = link.get("producer") or ""
        target = by_id.get(producer_id)
        if target is None:
            raise ValueError(f"Timeline track {producer_id!r} is missing from the project.")
        if _is_black(target):
            continue
        if target.tag not in {"playlist", "tractor"}:
            raise ValueError(f"Timeline track {producer_id!r} is not a playlist or track.")
        kind = _track_kind(target, link)
        counts[kind] += 1
        props = _properties(target)
        track_id = (props.get("kdenlive:chair_track_id") or "").strip()
        if not track_id:
            track_id = f"{TRACK_PREFIX[kind]}{counts[kind]}"
        name = (props.get("kdenlive:track_name") or "").strip()
        playlists = _track_playlists(target, by_id)
        if not name:
            for playlist in playlists:
                name = (_properties(playlist).get("kdenlive:track_name") or "").strip()
                if name:
                    break
        if not name:
            name = _default_track_name(kind, counts[kind])
        clips = _track_clips(playlists, by_id, num, den, track_id)
        tracks.append({"id": track_id, "kind": kind, "name": name, "clips": clips})
    return tracks


def _default_track_name(kind: str, count: int) -> str:
    if kind == "subtitle" and count == 1:
        return "Captions"
    return f"{TRACK_PREFIX[kind].upper()}{count}"


def _track_kind(element: ET.Element, link: ET.Element) -> str:
    props = _properties(element)
    declared = (props.get("kdenlive:track_type") or "").strip()
    if props.get("kdenlive:subtitle_track") == "1" or declared == "subtitle":
        return "subtitle"
    if declared == "effect":
        return "effect"
    if props.get("kdenlive:audio_track") == "1" or declared == "audio":
        return "audio"
    hides = [child.get("hide") for child in element if child.tag == "track"]
    if link.get("hide"):
        hides.append(link.get("hide"))
    hides = [hide for hide in hides if hide]
    if hides and all(hide == "video" for hide in hides):
        return "audio"
    return "video"


def _track_playlists(element: ET.Element, by_id: dict[str, ET.Element]) -> list[ET.Element]:
    if element.tag == "playlist":
        return [element]
    playlists = []
    for link in element:
        if link.tag != "track":
            continue
        target = by_id.get(link.get("producer") or "")
        if target is not None and target.tag == "playlist":
            playlists.append(target)
    return playlists


def _track_clips(
    playlists: list[ET.Element],
    by_id: dict[str, ET.Element],
    num: int,
    den: int,
    track_id: str,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for playlist in playlists:
        for clip in _playlist_clips(playlist, by_id, num, den):
            clip["_seq"] = len(found)
            found.append(clip)
    found.sort(key=lambda clip: (clip["timelineRange"]["start"]["value"], clip["_seq"]))
    clips = []
    for index, clip in enumerate(found, start=1):
        clip.pop("_seq")
        if not clip["id"]:
            clip["id"] = f"{track_id}-{index}"
        clips.append(clip)
    return clips


def _playlist_clips(
    playlist: ET.Element, by_id: dict[str, ET.Element], num: int, den: int
) -> list[dict[str, Any]]:
    position = 0
    clips = []
    for child in playlist:
        if child.tag == "blank":
            length = child.get("length")
            if length is None:
                raise ValueError("Kdenlive blank is missing a length.")
            frames = _parse_time(length, num, den)
            if frames < 0:
                raise ValueError("Kdenlive blank length is negative.")
            position += frames
            continue
        if child.tag != "entry":
            continue
        clip = _clip_from_entry(child, by_id, num, den, position)
        position += int(clip["timelineRange"]["duration"]["value"])
        clips.append(clip)
    return clips


def _clip_from_entry(
    entry: ET.Element,
    by_id: dict[str, ET.Element],
    num: int,
    den: int,
    position: int,
) -> dict[str, Any]:
    producer_id = entry.get("producer") or ""
    producer = by_id.get(producer_id)
    if producer is None:
        raise ValueError(f"Clip producer {producer_id!r} is missing from the project.")
    out_text = entry.get("out")
    if out_text is None:
        raise ValueError(f"Clip {producer_id!r} has no out point.")
    in_frame = _parse_time(entry.get("in"), num, den) if entry.get("in") is not None else 0
    out_frame = _parse_time(out_text, num, den)
    if out_frame < in_frame:
        raise ValueError(f"Clip {producer_id!r} ends before it starts.")
    timeline_frames = out_frame - in_frame + 1
    producer_props = _properties(producer)
    entry_props = _properties(entry)
    speed = _speed_of(entry_props) if _has_speed(entry_props) else _speed_of(producer_props)
    if speed == 1:
        source_in = in_frame
        source_frames = timeline_frames
    else:
        source_in = _nearest(Fraction(in_frame) * speed)
        source_frames = _nearest(Fraction(timeline_frames) * speed)
    media = _media_ref(producer_props)
    clip: dict[str, Any] = {
        "id": (entry_props.get("kdenlive:chair_clip_id") or "").strip(),
        "name": _clip_name(entry_props, producer_props, media),
    }
    if media:
        clip["mediaRef"] = media
    clip["sourceRange"] = _range(source_in, source_frames, num, den)
    clip["timelineRange"] = _range(position, timeline_frames, num, den)
    effects = _effects(entry)
    if effects:
        clip["effects"] = effects
    metadata = _clip_metadata(entry_props, producer, by_id)
    if metadata:
        clip["metadata"] = metadata
    return clip


def _clip_metadata(
    entry_props: dict[str, str], producer: ET.Element, by_id: dict[str, ET.Element]
) -> dict[str, Any] | None:
    raw = (entry_props.get("kdenlive:chair_metadata") or "").strip()
    if raw:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Clip metadata must be an object.")
        return parsed or None
    if _is_sequence(producer, by_id):
        return {"sequenceId": _sequence_id(producer, _properties(producer))}
    return None


def _effects(entry: ET.Element) -> list[dict[str, Any]]:
    effects = []
    index = 0
    for child in entry:
        if child.tag != "filter":
            continue
        index += 1
        props = _properties(child)
        service = (props.get("mlt_service") or "").strip()
        preset = (props.get("kdenlive_id") or "").strip() or service or "effect"
        params = {
            key: value
            for key, value in props.items()
            if key not in {"kdenlive_id", "mlt_service", "disable"}
        }
        if service and service != preset:
            params["mlt_service"] = service
        effect: dict[str, Any] = {
            "id": child.get("id") or f"effect-{index}",
            "presetName": preset,
            "params": params,
        }
        if props.get("disable") == "1":
            effect["enabled"] = False
        elif props.get("disable") == "0":
            effect["enabled"] = True
        effects.append(effect)
    return effects


def _clip_name(
    entry_props: dict[str, str], producer_props: dict[str, str], media: str | None
) -> str:
    for props in (entry_props, producer_props):
        name = (props.get("kdenlive:clipname") or "").strip()
        if name:
            return name
    if not media:
        return ""
    return Path(media).name


def _media_ref(props: dict[str, str]) -> str | None:
    resource = (props.get("resource") or "").strip()
    if _has_speed(props):
        _prefix, sep, rest = resource.partition(":")
        if not sep:
            return None
        resource = rest.strip()
    if resource in _SKIP_MEDIA:
        return None
    return resource


def _has_speed(props: dict[str, str]) -> bool:
    if (props.get("warp_speed") or "").strip():
        return True
    return props.get("mlt_service") == "timewarp"


def _speed_of(props: dict[str, str]) -> Fraction:
    raw = (props.get("warp_speed") or "").strip()
    if raw:
        return Fraction(raw)
    if props.get("mlt_service") == "timewarp":
        prefix, sep, _rest = (props.get("resource") or "").partition(":")
        if sep and prefix:
            return Fraction(prefix)
    return Fraction(1)


def _guide_text(sequence: ET.Element, root: ET.Element) -> str:
    props = _properties(sequence)
    if "kdenlive:sequenceproperties.guides" in props:
        return props["kdenlive:sequenceproperties.guides"]
    return _doc_properties(root).get("kdenlive:docproperties.guides", "")


def _markers(raw: str, num: int, den: int) -> list[dict[str, Any]]:
    text = raw.strip()
    if text == "":
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Kdenlive guides are not JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise ValueError("Kdenlive guides must be a JSON array.")
    markers = []
    used: set[str] = set()
    for item in parsed:
        if not isinstance(item, dict):
            raise ValueError("Kdenlive guide must be an object.")
        if "pos" not in item:
            raise ValueError("Kdenlive guide is missing pos.")
        pos = _json_frame(item["pos"], "pos")
        duration = 0
        if item.get("duration") not in (None, "", 0):
            duration = _json_frame(item["duration"], "duration")
        if duration < 0:
            raise ValueError("Kdenlive guide duration is negative.")
        comment = item.get("comment")
        name = comment.strip() if isinstance(comment, str) else ""
        marker: dict[str, Any] = {
            "id": _fresh_id(_marker_id(item, pos), used),
            "name": name,
            "time": _time(pos, num, den),
        }
        if duration > 0:
            marker["duration"] = _time(duration, num, den)
        marker["kind"] = _marker_kind(item, name, duration)
        note = item.get("note")
        if isinstance(note, str) and note.strip():
            marker["comment"] = note
        markers.append(marker)
    markers.sort(key=lambda marker: (marker["time"]["value"], marker["id"]))
    return markers


def _marker_id(item: dict[str, Any], pos: int) -> str:
    raw = item.get("id")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return f"m{pos}"


def _marker_kind(item: dict[str, Any], name: str, duration: int) -> str:
    raw = item.get("kind")
    if isinstance(raw, str) and raw.strip().casefold() in MARKER_KINDS:
        return raw.strip().casefold()
    if name.casefold() in MARKER_KINDS:
        return name.casefold()
    if duration > 0:
        return "range"
    return "user"


def _json_frame(value: Any, label: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"Kdenlive guide {label} is not a frame number.")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    raise ValueError(f"Kdenlive guide {label} is not a frame number.")


def _write_track(
    root: ET.Element,
    track: Any,
    num: int,
    den: int,
    used: set[str],
    producers: dict[tuple[str, str], str],
    placeholders: dict[str, str],
    timeline_id: str,
) -> ET.Element:
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
    lanes = _lanes(clips, num, den)
    while len(lanes) < 2:
        lanes.append([])
    hide = "video" if kind == "audio" else "audio" if kind == "video" else None
    playlist_ids = []
    for lane in lanes:
        playlist_id = _fresh_id("playlist", used)
        playlist_ids.append(playlist_id)
        playlist = ET.SubElement(root, "playlist", {"id": playlist_id})
        _write_lane(root, playlist, lane, num, den, used, producers, placeholders, timeline_id)
    tractor_id = _fresh_id("track", used)
    tractor = ET.SubElement(root, "tractor", {"id": tractor_id})
    _prop(tractor, "kdenlive:track_name", str(track["name"]))
    _prop(tractor, "kdenlive:chair_track_id", str(track["id"]))
    if kind == "audio":
        _prop(tractor, "kdenlive:audio_track", "1")
    elif kind == "subtitle":
        _prop(tractor, "kdenlive:subtitle_track", "1")
    elif kind == "effect":
        _prop(tractor, "kdenlive:track_type", "effect")
    for playlist_id in playlist_ids:
        attrib = {"producer": playlist_id}
        if hide:
            attrib["hide"] = hide
        ET.SubElement(tractor, "track", attrib)
    return tractor


def _lanes(clips: list[Any], num: int, den: int) -> list[list[dict[str, Any]]]:
    ordered: list[tuple[int, int, dict[str, Any]]] = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            raise TypeError("Clip must be an object.")
        start = _frames(clip.get("timelineRange"), num, den, "timeline start", part="start")
        ordered.append((start, index, clip))
    ordered.sort(key=lambda item: (item[0], str(item[2].get("id", "")), item[1]))
    lanes: list[list[dict[str, Any]]] = []
    ends: list[int] = []
    for start, _index, clip in ordered:
        duration = _frames(
            clip.get("timelineRange"), num, den, "timeline duration", part="duration"
        )
        if duration < 1:
            raise ValueError(f"Clip {clip.get('id')!r} has no timeline duration.")
        end = start + duration
        placed = False
        for lane_index, lane_end in enumerate(ends):
            if start >= lane_end:
                lanes[lane_index].append(clip)
                ends[lane_index] = end
                placed = True
                break
        if not placed:
            lanes.append([clip])
            ends.append(end)
    return lanes


def _write_lane(
    root: ET.Element,
    playlist: ET.Element,
    clips: list[dict[str, Any]],
    num: int,
    den: int,
    used: set[str],
    producers: dict[tuple[str, str], str],
    placeholders: dict[str, str],
    timeline_id: str,
) -> None:
    cursor = 0
    for clip in clips:
        for key in ("id", "name", "sourceRange", "timelineRange"):
            if key not in clip:
                raise ValueError(f"Clip is missing {key}.")
        start = _frames(
            clip["timelineRange"], num, den, f"Clip {clip['id']!r} timeline start", "start"
        )
        duration = _frames(
            clip["timelineRange"], num, den, f"Clip {clip['id']!r} timeline duration", "duration"
        )
        if start < cursor:
            raise ValueError(f"Clip {clip['id']!r} overlaps another clip on the same lane.")
        if start > cursor:
            ET.SubElement(playlist, "blank", {"length": str(start - cursor)})
        producer_id, entry_in, entry_out = _producer_for_clip(
            root, clip, num, den, used, producers, placeholders, timeline_id, duration
        )
        entry = ET.SubElement(
            playlist,
            "entry",
            {"producer": producer_id, "in": str(entry_in), "out": str(entry_out)},
        )
        _prop(entry, "kdenlive:id", str(clip["id"]))
        _prop(entry, "kdenlive:chair_clip_id", str(clip["id"]))
        _prop(entry, "kdenlive:clipname", str(clip["name"]))
        metadata = clip.get("metadata")
        if metadata:
            if not isinstance(metadata, dict):
                raise TypeError(f"Clip {clip['id']!r} metadata must be an object.")
            _prop(entry, "kdenlive:chair_metadata", json.dumps(metadata, separators=(",", ":")))
        for effect in clip.get("effects") or []:
            _write_effect(entry, effect)
        cursor = start + duration


def _producer_for_clip(
    root: ET.Element,
    clip: dict[str, Any],
    num: int,
    den: int,
    used: set[str],
    producers: dict[tuple[str, str], str],
    placeholders: dict[str, str],
    timeline_id: str,
    timeline_frames: int,
) -> tuple[str, int, int]:
    source_in = _frames(clip["sourceRange"], num, den, f"Clip {clip['id']!r} source start", "start")
    source_frames = _frames(
        clip["sourceRange"], num, den, f"Clip {clip['id']!r} source duration", "duration"
    )
    if source_frames < 1:
        raise ValueError(f"Clip {clip['id']!r} has no source duration.")
    metadata = clip.get("metadata") if isinstance(clip.get("metadata"), dict) else {}
    sequence_id = metadata.get("sequenceId") if isinstance(metadata, dict) else None
    if isinstance(sequence_id, str) and sequence_id.strip() and sequence_id != timeline_id:
        element_id = placeholders.get(sequence_id)
        if element_id is None:
            element_id = _fresh_id(_xml_id(sequence_id, "sequence"), used)
            placeholders[sequence_id] = element_id
        if source_frames != timeline_frames:
            raise ValueError(f"Nested sequence {clip['id']!r} cannot change speed.")
        return element_id, source_in, source_in + source_frames - 1

    speed = Fraction(source_frames, timeline_frames)
    media = clip.get("mediaRef")
    media_text = str(media) if isinstance(media, str) and media.strip() else ""
    if speed == 1:
        entry_in = source_in
        entry_out = source_in + source_frames - 1
        key = ("avformat", media_text or f"text:{clip['name']}")
        service = "avformat" if media_text else "qtext"
        resource = media_text
    else:
        entry_in = _nearest(Fraction(source_in) / speed)
        entry_out = entry_in + timeline_frames - 1
        if _nearest(Fraction(entry_in) * speed) != source_in:
            raise ValueError(f"Clip {clip['id']!r} speed does not land on whole source frames.")
        if _nearest(Fraction(timeline_frames) * speed) != source_frames:
            raise ValueError(f"Clip {clip['id']!r} speed does not land on whole source frames.")
        speed_text = str(speed.numerator) if speed.denominator == 1 else f"{float(speed)}"
        key = ("timewarp", f"{speed_text}:{media_text}")
        service = "timewarp"
        resource = f"{speed_text}:{media_text}" if media_text else speed_text
    producer_id = producers.get(key)
    if producer_id is None:
        producer_id = _fresh_id("chain" if service == "avformat" else "producer", used)
        producers[key] = producer_id
        tag = "chain" if service == "avformat" else "producer"
        producer = ET.SubElement(root, tag, {"id": producer_id})
        _prop(producer, "mlt_service", service)
        if service == "timewarp":
            _prop(producer, "warp_speed", speed_text)
        if resource:
            _prop(producer, "resource", resource)
        _prop(producer, "kdenlive:clipname", str(clip["name"]))
    return producer_id, entry_in, entry_out


def _write_effect(entry: ET.Element, effect: Any) -> None:
    if not isinstance(effect, dict):
        raise TypeError("Effect must be an object.")
    for key in ("id", "presetName", "params"):
        if key not in effect:
            raise ValueError(f"Effect is missing {key}.")
    params = effect["params"]
    if not isinstance(params, dict):
        raise TypeError("Effect params must be an object.")
    filt = ET.SubElement(entry, "filter", {"id": str(effect["id"])})
    preset = str(effect["presetName"])
    service = str(params.get("mlt_service") or preset)
    _prop(filt, "mlt_service", service)
    _prop(filt, "kdenlive_id", preset)
    if effect.get("enabled") is False:
        _prop(filt, "disable", "1")
    elif effect.get("enabled") is True:
        _prop(filt, "disable", "0")
    for key, value in params.items():
        if key == "mlt_service":
            continue
        if not isinstance(value, str):
            raise ValueError(f"Effect {effect['id']!r} parameter {key!r} must be a string.")
        _prop(filt, str(key), value)


def _write_placeholder(root: ET.Element, sequence_id: str, element_id: str) -> None:
    tractor = ET.SubElement(root, "tractor", {"id": element_id})
    _prop(tractor, "kdenlive:uuid", sequence_id)
    _prop(tractor, "kdenlive:clipname", sequence_id)
    ET.SubElement(tractor, "track", {"producer": "black_track"})


def _guides_json(markers: Any, num: int, den: int) -> str:
    if not isinstance(markers, list):
        raise TypeError("Timeline markers must be a list.")
    guides = []
    for marker in markers:
        if not isinstance(marker, dict):
            raise TypeError("Marker must be an object.")
        for key in ("id", "name", "time", "kind"):
            if key not in marker:
                raise ValueError(f"Marker is missing {key}.")
        kind = marker["kind"]
        if kind not in MARKER_KINDS:
            raise ValueError(f"Marker kind {kind!r} is not a Chair marker.")
        pos = _frames(marker["time"], num, den, f"Marker {marker['id']!r}", part=None)
        guide: dict[str, Any] = {
            "pos": pos,
            "comment": str(marker["name"]),
            "type": KIND_TYPE[kind],
            "duration": 0,
            "id": str(marker["id"]),
            "kind": kind,
        }
        if marker.get("duration") is not None:
            guide["duration"] = _frames(
                marker["duration"],
                num,
                den,
                f"Marker {marker['id']!r} duration",
                part=None,
            )
        note = marker.get("comment")
        if isinstance(note, str) and note.strip():
            guide["note"] = note
        guides.append(guide)
    guides.sort(key=lambda guide: (guide["pos"], guide["id"]))
    return json.dumps(guides, separators=(",", ":"))


def _frames(range_or_time: Any, num: int, den: int, label: str, part: str | None) -> int:
    if part is None:
        rational = range_or_time
    else:
        if not isinstance(range_or_time, dict) or part not in range_or_time:
            raise ValueError(f"{label} is missing.")
        rational = range_or_time[part]
    if not isinstance(rational, dict) or "value" not in rational or "rate" not in rational:
        raise ValueError(f"{label} must be a rational time.")
    value = rational["value"]
    rate = rational["rate"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} value must be a frame number.")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError(f"{label} rate must be positive.")
    if _same_rate(float(rate), num, den):
        if isinstance(value, float) and not value.is_integer():
            raise ValueError(f"{label} does not land on a whole frame.")
        frame = int(value)
    else:
        frames = Fraction(str(value)) * Fraction(num, den) / Fraction(str(rate))
        frame = _nearest(frames)
        if abs(frames - frame) > Fraction(1, 1000):
            raise ValueError(f"{label} does not land on a timeline frame.")
    if frame < 0:
        raise ValueError(f"{label} is negative.")
    return frame


def _same_rate(rate: float, num: int, den: int) -> bool:
    timeline = float(num) if den == 1 else num / den
    return abs(rate - timeline) < 1e-6


def _range(start: int, duration: int, num: int, den: int) -> dict[str, Any]:
    return {"start": _time(start, num, den), "duration": _time(duration, num, den)}


def _time(value: int, num: int, den: int) -> dict[str, int | float]:
    return {"value": value, "rate": num if den == 1 else num / den}


def _parse_time(text: str | None, num: int, den: int) -> int:
    if text is None or text.strip() == "":
        raise ValueError("Kdenlive time value is empty.")
    raw = text.strip()
    if raw.lstrip("-").isdigit():
        return int(raw)
    if raw.count(":") == 3 and "." not in raw:
        hours, minutes, seconds, frames = raw.split(":")
        try:
            base = int(hours) * 3600 + int(minutes) * 60 + int(seconds)
            extra = int(frames)
        except ValueError as exc:
            raise ValueError(f"Kdenlive time {text!r} is not a frame count.") from exc
        return _nearest(Fraction(base * num, den)) + extra
    parts = raw.split(":")
    clock = (
        len(parts) == 3
        and parts[0].isdigit()
        and parts[1].isdigit()
        and parts[2].replace(".", "", 1).isdigit()
    )
    if clock:
        whole, frac = (parts[2].split(".", 1) + [""])[:2]
        try:
            seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(whole)
        except ValueError as exc:
            raise ValueError(f"Kdenlive time {text!r} is not a frame count.") from exc
        scale = 10 ** len(frac) if frac else 1
        fraction = int(frac) if frac else 0
        numer = seconds * num * scale + fraction * num
        return _nearest(Fraction(numer, den * scale))
    raise ValueError(f"Kdenlive time {text!r} is not a frame count.")


def _nearest(value: Fraction) -> int:
    if value >= 0:
        return int(value + Fraction(1, 2))
    return -int(-value + Fraction(1, 2))


def _prop(parent: ET.Element, name: str, value: str) -> None:
    element = ET.SubElement(parent, "property", {"name": name})
    element.text = value


def _xml_id(value: str, fallback: str) -> str:
    if value and not any(char.isspace() or char in "<>&\"'" for char in value):
        return value
    return fallback


def _fresh_id(base: str, used: set[str]) -> str:
    if base not in used:
        used.add(base)
        return base
    number = 2
    while f"{base}{number}" in used:
        number += 1
    fresh = f"{base}{number}"
    used.add(fresh)
    return fresh
