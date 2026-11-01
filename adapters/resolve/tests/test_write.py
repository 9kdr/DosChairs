import sys
import types

import pytest
from chair_resolve.manifest import MANIFEST, Capabilities, Manifest
from chair_resolve.read import timeline_from_resolve
from chair_resolve.write import plan_from_timeline, write_timeline


def _time(value, rate=24):
    return {"value": value, "rate": rate}


def _range(start, duration, rate=24):
    return {"start": _time(start, rate), "duration": _time(duration, rate)}


def _clip(clip_id, media, start=86400, span=48, source=100, effects=None):
    clip = {
        "id": clip_id,
        "name": clip_id,
        "sourceRange": _range(source, span),
        "timelineRange": _range(start, span),
    }
    if media is not None:
        clip["mediaRef"] = media
    if effects is not None:
        clip["effects"] = effects
    return clip


TIMELINE = {
    "schemaVersion": "0.1.0",
    "id": "tl-write",
    "name": "Write cut",
    "rate": {"num": 24, "den": 1},
    "tracks": [
        {
            "id": "v1",
            "kind": "video",
            "name": "V1",
            "clips": [
                _clip(
                    "clip-a",
                    "/media/a.mov",
                    effects=[
                        {
                            "id": "fx-glow",
                            "presetName": "Chair Glow",
                            "params": {"compPath": "/macros/glow.comp"},
                        }
                    ],
                )
            ],
        },
        {
            "id": "a1",
            "kind": "audio",
            "name": "A1",
            "clips": [_clip("clip-audio", "/media/a.mov", start=86400, span=24)],
        },
        {
            "id": "s1",
            "kind": "subtitle",
            "name": "Captions",
            "clips": [_clip("sub-hi", None, start=86412, span=24, source=0)],
        },
    ],
    "markers": [
        {
            "id": "m-hook",
            "name": "Hook",
            "time": _time(86410),
            "duration": _time(8),
            "kind": "hook",
        },
        {
            "id": "m-note",
            "name": "Note",
            "time": _time(86420),
            "kind": "user",
            "comment": "check",
        },
    ],
}

FUSION_OFF = Manifest(
    adapter="resolve",
    version="0.1.0",
    capabilities=Capabilities(
        keyframes=True,
        fusion_comps=False,
        adjustment_layers=True,
        markers=True,
        subtitles=True,
        nested_sequences=True,
        speed_changes=True,
    ),
    fallbacks={
        "fusionComps": "prerendered overlay track",
        "subtitles": "import captions in Studio by hand",
        "adjustmentLayers": "add an adjustment clip in Studio by hand",
    },
)


def test_plan_places_clips_markers_and_fusion() -> None:
    plan = plan_from_timeline(TIMELINE)

    assert plan["timeline_name"] == "Write cut"
    assert plan["frame_rate"] == "24"
    assert plan["tracks"] == [
        {"track_type": "video", "index": 1, "name": "V1"},
        {"track_type": "audio", "index": 1, "name": "A1"},
    ]
    assert plan["clips"] == [
        {
            "clip_id": "clip-a",
            "name": "clip-a",
            "media_path": "/media/a.mov",
            "start_frame": 100,
            "end_frame": 147,
            "track_type": "video",
            "track_index": 1,
            "record_frame": 86400,
            "media_type": 1,
        },
        {
            "clip_id": "clip-audio",
            "name": "clip-audio",
            "media_path": "/media/a.mov",
            "start_frame": 100,
            "end_frame": 123,
            "track_type": "audio",
            "track_index": 1,
            "record_frame": 86400,
            "media_type": 2,
        },
    ]
    assert plan["markers"] == [
        {
            "frame": 86410,
            "color": "Green",
            "name": "Hook",
            "note": "",
            "duration": 8,
            "custom_data": "hook",
        },
        {
            "frame": 86420,
            "color": "Blue",
            "name": "Note",
            "note": "check",
            "duration": 0,
            "custom_data": "user",
        },
    ]
    assert plan["fusion"] == [
        {
            "clip_id": "clip-a",
            "effect_id": "fx-glow",
            "preset": "Chair Glow",
            "comp_path": "/macros/glow.comp",
        }
    ]
    assert plan["skipped"] == [
        {
            "kind": "track",
            "id": "s1",
            "reason": f"Subtitle track 's1': {MANIFEST.fallbacks['subtitles']}",
        }
    ]


def test_plan_end_frame_is_inclusive() -> None:
    """Official example 7: frames 0..23 are the first 24 frames."""
    plan = plan_from_timeline(
        {
            "id": "tl",
            "name": "Cut",
            "rate": {"num": 24, "den": 1},
            "tracks": [
                {
                    "id": "v1",
                    "kind": "video",
                    "name": "V1",
                    "clips": [_clip("c", "/media/c.mov", start=0, span=24, source=0)],
                }
            ],
            "markers": [],
        }
    )
    clip = plan["clips"][0]
    assert (clip["start_frame"], clip["end_frame"]) == (0, 23)


def test_plan_skips_effect_tracks_and_bare_clips() -> None:
    plan = plan_from_timeline(
        {
            "id": "tl",
            "name": "Cut",
            "rate": {"num": 24, "den": 1},
            "tracks": [
                {
                    "id": "e1",
                    "kind": "effect",
                    "name": "Grade",
                    "clips": [_clip("fx-clip", "/media/x.mov")],
                },
                {
                    "id": "v1",
                    "kind": "video",
                    "name": "V1",
                    "clips": [_clip("title", None)],
                },
            ],
            "markers": [],
        }
    )
    assert plan["clips"] == []
    assert plan["fusion"] == []
    assert [skip["id"] for skip in plan["skipped"]] == ["e1", "title"]
    assert MANIFEST.fallbacks["adjustmentLayers"] in plan["skipped"][0]["reason"]


def test_fusion_off_applies_the_manifest_fallback() -> None:
    plan = plan_from_timeline(TIMELINE, FUSION_OFF)
    assert plan["fusion"] == []
    assert plan["skipped"][0] == {
        "kind": "effect",
        "id": "fx-glow",
        "reason": "Effect 'fx-glow' ('Chair Glow'): prerendered overlay track",
    }


def test_fusion_effect_needs_a_comp_file() -> None:
    bad = {
        "id": "tl",
        "name": "Cut",
        "rate": {"num": 24, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    _clip(
                        "c",
                        "/media/c.mov",
                        effects=[{"id": "fx", "presetName": "Macro", "params": {}}],
                    )
                ],
            }
        ],
        "markers": [],
    }
    with pytest.raises(ValueError, match="compPath"):
        plan_from_timeline(bad)


def test_disabled_effect_is_skipped() -> None:
    clip = _clip(
        "c",
        "/media/c.mov",
        effects=[{"id": "fx", "presetName": "Macro", "params": {}, "enabled": False}],
    )
    plan = plan_from_timeline(
        {
            "id": "tl",
            "name": "Cut",
            "rate": {"num": 24, "den": 1},
            "tracks": [{"id": "v1", "kind": "video", "name": "V1", "clips": [clip]}],
            "markers": [],
        }
    )
    assert plan["fusion"] == []
    assert plan["skipped"] == [
        {"kind": "effect", "id": "fx", "reason": "Effect 'fx' is disabled."}
    ]


@pytest.mark.parametrize(
    "timeline, match",
    [
        ({"id": "tl", "name": "Cut", "rate": {"num": 24, "den": 1}, "markers": []}, "tracks"),
        (
            {
                "id": "tl",
                "name": "Cut",
                "rate": {"num": 24, "den": 0},
                "tracks": [],
                "markers": [],
            },
            "positive integers",
        ),
        (
            {
                "id": "tl",
                "name": "Cut",
                "rate": {"num": 24, "den": 1},
                "tracks": [{"id": "x1", "kind": "midi", "name": "X", "clips": []}],
                "markers": [],
            },
            "midi",
        ),
        (
            {
                "id": "tl",
                "name": "Cut",
                "rate": {"num": 23, "den": 1},
                "tracks": [],
                "markers": [],
            },
            "23/1",
        ),
    ],
)
def test_bad_timelines_raise(timeline: dict, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        plan_from_timeline(timeline)


def test_fractional_marker_frame_raises() -> None:
    timeline = {
        "id": "tl",
        "name": "Cut",
        "rate": {"num": 24, "den": 1},
        "tracks": [],
        "markers": [{"id": "m", "name": "M", "time": _time(10.5), "kind": "user"}],
    }
    with pytest.raises(ValueError, match="whole frame"):
        plan_from_timeline(timeline)


def test_markers_round_trip_through_read() -> None:
    plan = plan_from_timeline(TIMELINE)
    snapshot = {
        "name": "Write cut",
        "frame_rate": "24",
        "tracks": [],
        "markers": {
            marker["frame"]: {
                "name": marker["name"],
                "color": marker["color"],
                "duration": marker["duration"],
                "note": marker["note"],
                "customData": marker["custom_data"],
            }
            for marker in plan["markers"]
        },
    }
    reread = timeline_from_resolve(snapshot)
    assert [(m["name"], m["kind"]) for m in reread["markers"]] == [
        ("Hook", "hook"),
        ("Note", "user"),
    ]
    assert reread["markers"][1]["comment"] == "check"
    assert reread["markers"][0]["duration"] == {"value": 8, "rate": 24}


class _FakeItem:
    def __init__(self, log: list, name: str) -> None:
        self._log = log
        self._name = name

    def ImportFusionComp(self, path: str):
        self._log.append(("import_fusion", self._name, path))
        return object()


class _FakeTimeline:
    def __init__(self, log: list, counts: dict) -> None:
        self._log = log
        self._counts = counts

    def SetSettings(self, settings: dict) -> bool:
        self._log.append(("settings", settings))
        return True

    def GetTrackCount(self, track_type: str) -> int:
        return self._counts.get(track_type, 0)

    def AddTrack(self, track_type: str) -> bool:
        self._log.append(("add_track", track_type))
        self._counts[track_type] = self._counts.get(track_type, 0) + 1
        return True

    def SetTrackName(self, track_type: str, index: int, name: str) -> bool:
        self._log.append(("track_name", track_type, index, name))
        return True

    def AddMarker(
        self,
        frame: int,
        color: str,
        name: str,
        note: str,
        duration: int,
        custom_data=None,
    ) -> bool:
        self._log.append(("marker", frame, color, name, note, duration, custom_data))
        return True


class _FakeMediaPool:
    def __init__(self, log: list, timeline: _FakeTimeline | None) -> None:
        self._log = log
        self._timeline = timeline

    def ImportMedia(self, clips: list) -> list:
        self._log.append(("import", [c["FilePath"] for c in clips]))
        return [object() for _ in clips]

    def CreateEmptyTimeline(self, name: str) -> _FakeTimeline | None:
        self._log.append(("create_timeline", name))
        return self._timeline

    def AppendToTimeline(self, clips: list) -> list:
        self._log.append(("append", clips))
        return [_FakeItem(self._log, f"item-{i}") for i in range(len(clips))]


class _FakeProject:
    def __init__(self, log: list, pool: _FakeMediaPool) -> None:
        self._log = log
        self._pool = pool

    def GetMediaPool(self):
        return self._pool

    def SetCurrentTimeline(self, timeline) -> bool:
        self._log.append(("current", timeline is self._pool._timeline))
        return True


def _fake_resolve(log: list, counts: dict | None = None):
    timeline = _FakeTimeline(log, dict(counts or {}))
    pool = _FakeMediaPool(log, timeline)
    project = _FakeProject(log, pool)
    return types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )


def test_write_timeline_drives_studio() -> None:
    log: list = []
    summary = write_timeline(TIMELINE, resolve=_fake_resolve(log))

    assert summary == {
        "timeline": "Write cut",
        "tracks": 2,
        "clips": 2,
        "markers": 2,
        "fusion": 1,
        "skipped": 1,
    }
    assert ("import", ["/media/a.mov"]) in log
    assert ("create_timeline", "Write cut") in log
    assert ("current", True) in log
    assert ("settings", {"timelineFrameRate": "24"}) in log
    assert ("add_track", "video") in log
    assert ("add_track", "audio") in log
    assert ("track_name", "video", 1, "V1") in log
    assert ("track_name", "audio", 1, "A1") in log
    appended = next(entry[1] for entry in log if entry[0] == "append")
    assert [(c["mediaType"], c["trackIndex"], c["recordFrame"]) for c in appended] == [
        (1, 1, 86400),
        (2, 1, 86400),
    ]
    assert [(c["startFrame"], c["endFrame"]) for c in appended] == [(100, 147), (100, 123)]
    assert ("marker", 86410, "Green", "Hook", "", 8, "hook") in log
    assert ("marker", 86420, "Blue", "Note", "check", 0, "user") in log
    assert ("import_fusion", "item-0", "/macros/glow.comp") in log


def test_write_timeline_keeps_existing_tracks() -> None:
    log: list = []
    write_timeline(TIMELINE, resolve=_fake_resolve(log, {"video": 2, "audio": 1}))
    assert ("add_track", "video") not in log
    assert ("add_track", "audio") not in log


def test_write_timeline_without_studio_errors_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    from chair_resolve.read import ResolveClosedError

    monkeypatch.setitem(sys.modules, "DaVinciResolveScript", None)
    with pytest.raises(ResolveClosedError, match="closed"):
        write_timeline(TIMELINE)

    empty = types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: None)
    )
    with pytest.raises(ResolveClosedError, match="no project open"):
        write_timeline(TIMELINE, resolve=empty)


def test_write_timeline_fails_when_create_empty_timeline_returns_none() -> None:
    log: list = []
    resolve = _fake_resolve(log)
    resolve.GetProjectManager().GetCurrentProject().GetMediaPool()._timeline = None
    with pytest.raises(RuntimeError, match=r"Write cut.*already exists"):
        write_timeline(TIMELINE, resolve=resolve)
    assert ("create_timeline", "Write cut") in log
    assert not any(entry[0] == "import" for entry in log)


def test_write_timeline_fails_when_set_current_timeline_fails() -> None:
    log: list = []
    resolve = _fake_resolve(log)
    resolve.GetProjectManager().GetCurrentProject().SetCurrentTimeline = lambda _tl: False
    with pytest.raises(RuntimeError, match="Studio could not set current timeline to 'Write cut'"):
        write_timeline(TIMELINE, resolve=resolve)
    assert ("create_timeline", "Write cut") in log
    assert not any(entry[0] == "import" for entry in log)
