"""Cut edits land on a timeline copy, with undo and honest skips (#293)."""

import types

import pytest
from chair_resolve.cut_apply import apply_cut_items, describe_cut_report, undo_copy_write
from chair_resolve.manifest import MANIFEST
from chair_resolve.write import plan_from_timeline, write_timeline


def _time(value, rate=24):
    return {"value": value, "rate": rate}


def _range(start, duration, rate=24):
    return {"start": _time(start, rate), "duration": _time(duration, rate)}


def _clip(clip_id, media, start=0, span=48, source=100):
    clip = {
        "id": clip_id,
        "name": clip_id,
        "sourceRange": _range(source, span),
        "timelineRange": _range(start, span),
    }
    if media is not None:
        clip["mediaRef"] = media
    return clip


def _timeline():
    return {
        "schemaVersion": "0.1.0",
        "id": "tl-cut",
        "name": "Cut",
        "rate": {"num": 24, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    _clip("clip-a", "/media/a.mov", start=0, span=48),
                    _clip("clip-b", "/media/b.mov", start=48, span=48),
                ],
            },
            {
                "id": "v2",
                "kind": "video",
                "name": "V2",
                "clips": [],
            },
        ],
        "markers": [],
    }


def _item(item_id, op, patch=None, target=None):
    item = {
        "id": item_id, "op": op, "rationale": f"{op} for the cut.",
        "patch": patch or {}, "status": "pending",
    }
    if target is not None:
        item["targetId"] = target
    return item


def _clip_of(copy, clip_id):
    for track in copy["tracks"]:
        for clip in track.get("clips", []):
            if clip["id"] == clip_id:
                return track, clip
    raise AssertionError(f"{clip_id} is not on the copy")


def test_trim_move_remove_land_on_a_copy() -> None:
    timeline = _timeline()
    copy, report = apply_cut_items(timeline, [
        _item("trim-1", "trim", {"trimStartFrames": 12, "trimEndFrames": 4}, "clip-a"),
        _item("move-1", "move", {"toTrackId": "v2", "startFrames": 96}, "clip-b"),
        _item("rm-1", "remove_clip", {}, "clip-a"),
    ])

    assert timeline == _timeline()  # the input is never mutated
    assert report["skipped"] == []
    assert report["clips_changed"] == ["clip-a", "clip-b"]
    assert report["clips_removed"] == ["clip-a"]
    track, moved = _clip_of(copy, "clip-b")
    assert track["id"] == "v2"
    assert moved["timelineRange"]["start"] == {"value": 96, "rate": 24}
    assert [c["id"] for c in copy["tracks"][0]["clips"]] == []
    assert "clips removed: 1 (clip-a)" in describe_cut_report(report)


def test_trim_shifts_source_and_timeline_together() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("trim-1", "trim", {"trimStartFrames": 12, "trimEndFrames": 4}, "clip-a"),
    ])
    _, clip = _clip_of(copy, "clip-a")
    assert clip["timelineRange"] == {"start": _time(12), "duration": _time(32)}
    assert clip["sourceRange"] == {"start": _time(112), "duration": _time(32)}
    assert report["clips_changed"] == ["clip-a"]


def test_partial_cut_shrinks_head_or_tail() -> None:
    head, _ = apply_cut_items(_timeline(), [
        _item("cut-1", "remove_clip", {"startFrames": 0, "frames": 8}, "clip-a"),
    ])
    assert _clip_of(head, "clip-a")[1]["timelineRange"]["start"] == _time(8)
    assert _clip_of(head, "clip-a")[1]["timelineRange"]["duration"] == _time(40)
    tail, _ = apply_cut_items(_timeline(), [
        _item("cut-2", "remove_clip", {"startFrames": 40, "frames": 8}, "clip-b"),
    ])
    assert _clip_of(tail, "clip-b")[1]["timelineRange"]["start"] == _time(48)
    assert _clip_of(tail, "clip-b")[1]["timelineRange"]["duration"] == _time(40)


def test_mid_clip_cut_splits_the_copy_and_never_touches_the_input() -> None:
    timeline = _timeline()
    copy, report = apply_cut_items(timeline, [
        _item("cut-1", "remove_clip", {"startFrames": 8, "frames": 8}, "clip-a"),
    ])

    assert timeline == _timeline()  # the input is never mutated
    assert report["skipped"] == []
    _, head = _clip_of(copy, "clip-a")
    assert head["timelineRange"] == {"start": _time(0), "duration": _time(8)}
    assert head["sourceRange"] == {"start": _time(100), "duration": _time(8)}
    track, _ = _clip_of(copy, "clip-a")
    ids = [entry["id"] for entry in track["clips"]]
    assert ids[:2] == ["clip-a", "clip-a-cut"]
    _, tail = _clip_of(copy, "clip-a-cut")
    assert tail["timelineRange"] == {"start": _time(16), "duration": _time(32)}
    assert tail["sourceRange"] == {"start": _time(116), "duration": _time(32)}
    assert tail["mediaRef"] == "/media/a.mov"
    assert report["clips_changed"] == ["clip-a", "clip-a-cut"]


def test_cut_outside_the_clip_skips_without_trimming() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("cut-1", "remove_clip", {"startFrames": 48, "frames": 8}, "clip-a"),
    ])

    assert copy == _timeline()
    assert report["clips_changed"] == []
    assert [skip["id"] for skip in report["skipped"]] == ["cut-1"]
    assert "falls outside the clip" in report["skipped"][0]["reason"]


def test_ripple_moves_the_clip_and_everything_after_it() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("rip-1", "ripple", {"shiftFrames": 24}, "clip-a"),
    ])
    assert _clip_of(copy, "clip-a")[1]["timelineRange"]["start"] == _time(24)
    assert _clip_of(copy, "clip-b")[1]["timelineRange"]["start"] == _time(72)
    assert report["clips_changed"] == ["clip-a"]


def test_picture_insert_places_a_snapshot_on_a_video_track() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("ins-1", "add_clip", {"clip": _clip(
            "clip-c", "/media/c.mov", start=24, span=24)}, "v1"),
    ])
    assert report["clips_placed"] == ["clip-c"]
    assert [c["id"] for c in copy["tracks"][0]["clips"]] == ["clip-a", "clip-c", "clip-b"]
    plan = plan_from_timeline(copy)
    placed = next(c for c in plan["clips"] if c["clip_id"] == "clip-c")
    assert (placed["media_path"], placed["record_frame"], placed["media_type"]) == (
        "/media/c.mov", 24, 1)
    assert "clips placed: 1 (clip-c)" in describe_cut_report(report)


def test_marker_and_video_track_land() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("trk-1", "add_track", {"track": {"id": "v3", "kind": "video", "name": "V3"}}),
        _item("mk-1", "add_marker", {"marker": {
            "id": "m-1", "name": "Payoff", "time": _time(96), "kind": "hook"}}),
    ])
    assert report["tracks_added"] == ["v3"]
    assert report["markers_added"] == ["m-1"]
    assert copy["markers"] == [
        {"id": "m-1", "name": "Payoff", "time": _time(96), "kind": "hook"}
    ]


def test_unsupported_ops_skip_with_reasons_never_silently() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("spd-1", "set_speed", {"rate": 2.0}, "clip-a"),
        _item("tr-1", "add_transition",
              {"transition": "cross-dissolve", "durationFrames": 12}, "clip-a"),
        _item("fx-1", "add_effect", {"effectId": "fx-x"}, "clip-a"),
        _item("g-1", "set_gain", {"gainDb": -6.0}, "clip-a"),
        _item("sfx-1", "add_clip", {"kind": "riser",
              "clip": _clip("sfx-1", "/sfx/r.wav", start=0, span=24)}, "v1"),
        _item("lost-1", "trim", {"trimStartFrames": 4}, "clip-nope"),
        _item("bare-1", "add_clip", {"clip": _clip("bare-1", None)}, "v1"),
        _item("zero-1", "trim", {"trimStartFrames": 999}, "clip-a"),
        _item("mk-bad", "add_marker", {"marker": {
            "id": "m-bad", "name": "Bad", "time": _time(10.5), "kind": "user"}}),
    ])
    assert copy == _timeline()
    assert [skip["id"] for skip in report["skipped"]] == [
        "spd-1", "tr-1", "fx-1", "g-1", "sfx-1", "lost-1", "bare-1", "zero-1", "mk-bad",
    ]
    by_id = {skip["id"]: skip["reason"] for skip in report["skipped"]}
    assert MANIFEST.fallbacks["speedChanges"] in by_id["spd-1"]
    assert MANIFEST.fallbacks["transitions"] in by_id["tr-1"]
    assert "Piece Maker" in by_id["fx-1"]
    assert "does not place set_gain items" in by_id["g-1"]
    assert "does not place sound clips" in by_id["sfx-1"]
    assert "names no clip on the copy" in by_id["lost-1"]
    assert "no mediaRef" in by_id["bare-1"]
    assert "trims the whole clip away" in by_id["zero-1"]
    assert "not on a whole frame" in by_id["mk-bad"]
    assert "skipped spd-1" in describe_cut_report(report)


class _FakeWrittenTimeline:
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

    def AddMarker(self, frame, color, name, note, duration, custom_data=None) -> bool:
        self._log.append(("marker", frame, color, name, note, duration, custom_data))
        return True


class _FakePool:
    def __init__(self, log: list) -> None:
        self._log = log

    def ImportMedia(self, clips: list) -> list:
        self._log.append(("import", list(clips)))
        return [object() for _ in clips]

    def CreateEmptyTimeline(self, name: str):
        self._log.append(("create_timeline", name))
        return _FakeWrittenTimeline(self._log, {})

    def AppendToTimeline(self, clips: list) -> list:
        self._log.append(("append", clips))
        return [object() for _ in clips]


class _FakeProject:
    def __init__(self, log: list) -> None:
        self._log = log
        self.pool = _FakePool(log)

    def GetMediaPool(self):
        return self.pool

    def SetCurrentTimeline(self, timeline) -> bool:
        self._log.append(("current", True))
        return True


def _fake_resolve(log: list):
    project = _FakeProject(log)
    return types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )


def test_cut_copy_places_through_the_normal_write_path() -> None:
    copy, report = apply_cut_items(_timeline(), [
        _item("trim-1", "trim", {"trimStartFrames": 12}, "clip-a"),
    ])
    copy["name"] = "Cut (cut copy)"
    log: list = []
    summary = write_timeline(copy, resolve=_fake_resolve(log))

    assert summary["timeline"] == "Cut (cut copy)"
    assert summary["clips"] == 2
    assert ("create_timeline", "Cut (cut copy)") in log
    appended = next(entry[1] for entry in log if entry[0] == "append")
    trimmed = appended[0]  # the plan sorts by record frame: clip-a lands first
    assert (trimmed["startFrame"], trimmed["endFrame"], trimmed["recordFrame"]) == (112, 147, 12)
    assert report["clips_changed"] == ["clip-a"]


class _FakeTimeline:
    def __init__(self, name: str) -> None:
        self._name = name

    def GetName(self) -> str:
        return self._name


class _FakeUndoProject:
    def __init__(self, names: list) -> None:
        self.timelines = [_FakeTimeline(name) for name in names]
        self.current = self.timelines[0]
        self.deleted: list = []
        deleted = self.deleted

        def _delete(members):
            deleted.extend(members)
            return True

        self.pool = types.SimpleNamespace(DeleteTimelines=_delete)

    def GetTimelineCount(self) -> int:
        return len(self.timelines)

    def GetTimelineByIndex(self, index: int):
        if 1 <= index <= len(self.timelines):
            return self.timelines[index - 1]
        return None

    def SetCurrentTimeline(self, timeline) -> bool:
        self.current = timeline
        return True

    def GetMediaPool(self):
        return self.pool


def test_undo_switches_back_and_keeps_the_copy() -> None:
    project = _FakeUndoProject(["Cut", "Cut (cut copy)"])
    project.current = project.timelines[1]

    undone = undo_copy_write(project, "Cut (cut copy)", "Cut")

    assert undone == {"current_timeline": "Cut", "deleted": False}
    assert project.current.GetName() == "Cut"
    assert project.deleted == []


def test_undo_deletes_the_copy_only_when_asked() -> None:
    project = _FakeUndoProject(["Cut", "Cut (cut copy)"])

    undone = undo_copy_write(project, "Cut (cut copy)", "Cut", delete_copy=True)

    assert undone == {"current_timeline": "Cut", "deleted": True}
    assert [t.GetName() for t in project.deleted] == ["Cut (cut copy)"]
    with pytest.raises(ValueError, match="refuses to delete the original"):
        undo_copy_write(project, "Cut", "Cut", delete_copy=True)


def test_redo_lands_the_copy_again_after_undo() -> None:
    project = _FakeUndoProject(["Cut", "Cut (cut copy)"])
    undo_copy_write(project, "Cut (cut copy)", "Cut")

    copy, report = apply_cut_items(_timeline(), [
        _item("trim-1", "trim", {"trimStartFrames": 12}, "clip-a"),
    ])
    copy["name"] = "Cut (cut copy) 2"
    log: list = []
    summary = write_timeline(copy, resolve=_fake_resolve(log))

    assert summary["timeline"] == "Cut (cut copy) 2"
    assert ("create_timeline", "Cut (cut copy) 2") in log
    assert report["clips_changed"] == ["clip-a"]
    assert project.current.GetName() == "Cut"
