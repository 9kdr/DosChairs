"""Cut apply/undo routes and health counters (#293)."""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent import cuts
from chair_agent.__main__ import Handler


@pytest.fixture(autouse=True)
def _fresh_cut_status():
    before = cuts.status_snapshot()
    cuts._STATUS.update({
        "landed": 0, "undone": 0, "skipped_ops": 0,
        "last_error": None, "last_write_ms": None,
    })
    yield
    cuts._STATUS.update(before)


class _FakeCutItem:
    def __init__(self, name: str, start: int, end: int, path: str) -> None:
        self._name = name
        self._start = start
        self._end = end
        self._path = path

    def GetUniqueId(self) -> str:
        return f"uid-{self._name}"

    def GetName(self) -> str:
        return self._name

    def GetStart(self) -> int:
        return self._start

    def GetEnd(self) -> int:
        return self._end

    def GetSourceStartFrame(self) -> int:
        return 0

    def GetSourceEndFrame(self) -> int:
        return self._end - self._start

    def GetMediaPoolItem(self):
        import types as _types

        path = self._path
        return _types.SimpleNamespace(
            GetClipProperty=lambda name: path if name == "File Path" else "",
        )


class _FakeCutTimeline:
    def __init__(self, name: str, items=()) -> None:
        self._name = name
        self._items = list(items)

    def GetName(self) -> str:
        return self._name

    def GetUniqueId(self) -> str:
        return f"tl-{self._name}"

    def GetStartFrame(self):
        return None

    def GetSetting(self, key: str):
        return "30" if key == "timelineFrameRate" else None

    def GetTrackCount(self, kind: str) -> int:
        return 1 if kind == "video" else 0

    def GetItemListInTrack(self, kind: str, index: int):
        return list(self._items) if kind == "video" and index == 1 else []

    def GetTrackName(self, kind: str, index: int) -> str:
        return "Video 1"

    def GetMarkers(self) -> dict:
        return {}


class _FakeCutProject:
    def __init__(self, name: str, timelines) -> None:
        import types as _types

        self._name = name
        self.timelines = list(timelines)
        self.current = self.timelines[0]
        self.deleted: list = []
        deleted = self.deleted

        def _delete(members):
            deleted.extend(members)
            return True

        self.pool = _types.SimpleNamespace(DeleteTimelines=_delete)

    def GetName(self) -> str:
        return self._name

    def GetTimelineCount(self) -> int:
        return len(self.timelines)

    def GetTimelineByIndex(self, index: int):
        if 1 <= index <= len(self.timelines):
            return self.timelines[index - 1]
        return None

    def GetCurrentTimeline(self):
        return self.current

    def SetCurrentTimeline(self, timeline) -> bool:
        self.current = timeline
        return True

    def GetMediaPool(self):
        return self.pool


def _install_cut_resolve(monkeypatch: pytest.MonkeyPatch, project) -> None:
    import sys as _sys
    import types as _types

    manager = _types.SimpleNamespace(GetCurrentProject=lambda: project)
    bmd = _types.ModuleType("DaVinciResolveScript")
    bmd.scriptapp = lambda name: _types.SimpleNamespace(GetProjectManager=lambda: manager)
    monkeypatch.setitem(_sys.modules, "DaVinciResolveScript", bmd)


def _cut_ops() -> list:
    from chair_agent.edit_ops import move_op, speed_op, trim_op

    return [
        item.model_dump(mode="json", by_alias=True)
        for item in [
            trim_op("trim-1", "uid-a.mov", "Trim the head.",
                    start_frames=12, end_frames=4),
            move_op("move-1", "uid-b.mov", "Move the b-roll.",
                    to_track_id="v1", start_frames=96),
            speed_op("spd-1", "uid-a.mov", "Slow it down.", rate=0.5),
        ]
    ]


def _serve(controller):
    old = getattr(Handler, "controller", None)
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, old


def _stop(server, thread, old) -> None:
    server.shutdown()
    thread.join(timeout=2)
    server.server_close()
    if old is None:
        del Handler.controller
    else:
        Handler.controller = old


def _post_json(port: int, path: str, payload: dict):
    from urllib.error import HTTPError

    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def _get_json(port: int, path: str):
    with urlopen(f"http://127.0.0.1:{port}{path}") as response:
        return response.status, json.load(response)


def _project():
    items = [
        _FakeCutItem("a.mov", 0, 90, "/media/a.mov"),
        _FakeCutItem("b.mov", 90, 180, "/media/b.mov"),
    ]
    return _FakeCutProject("Chair Captest", [_FakeCutTimeline("Timeline 1", items)])


def test_cuts_apply_writes_a_named_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    project = _project()
    _install_cut_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    job = controller.submit("edit", {"brief": "trim the silences"})
    controller.claim_next()
    controller.finish_completed(job.request_id, ops=_cut_ops())

    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        status, applied = _post_json(port, "/cuts/apply", {
            "jobId": job.request_id, "project": "Chair Captest",
        })
        assert status == 200
        assert applied["timeline_name"] == "Timeline 1 (cut copy)"
        assert applied["original_timeline"] == "Timeline 1"
        assert applied["clips_changed"] == 2
        assert applied["clips_added"] == 0
        assert [skip["intent"] for skip in applied["skipped"]] == ["spd-1"]
        assert "retime the clip in Studio by hand" in applied["skipped"][0]["reason"]
        assert applied["fallback"] is None
        assert len(written) == 1
        assert written[0]["name"] == "Timeline 1 (cut copy)"
        # The trim landed on the copy: head +12 at 30 fps source.
        clips = written[0]["tracks"][0]["clips"]
        assert clips[0]["timelineRange"]["start"] == {"value": 15, "rate": 30}
        assert clips[1]["timelineRange"]["start"] == {"value": 96, "rate": 24}
        # The fake original is untouched: still current, still two items.
        assert project.current.GetName() == "Timeline 1"
        assert len(project.timelines[0]._items) == 2
    finally:
        _stop(server, thread, old)


def test_cuts_apply_suffixes_a_taken_copy_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    project = _FakeCutProject("Chair Captest", [
        _FakeCutTimeline("Timeline 1", [
            _FakeCutItem("a.mov", 0, 90, "/media/a.mov"),
        ]),
        _FakeCutTimeline("Timeline 1 (cut copy)"),
    ])
    _install_cut_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        status, applied = _post_json(port, "/cuts/apply", {"items": _cut_ops()[:1]})
        assert status == 200
        assert applied["timeline_name"] == "Timeline 1 (cut copy) 2"
        assert written[0]["name"] == "Timeline 1 (cut copy) 2"
    finally:
        _stop(server, thread, old)


def test_cuts_apply_errors_are_plain_sentences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent.jobs import JobController

    _install_cut_resolve(monkeypatch, _project())
    controller = JobController(tmp_path / "jobs.json")
    queued = controller.submit("edit", {"brief": "trim"})
    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        status, body = _post_json(port, "/cuts/apply", {})
        assert status == 400
        assert body == {"error": "apply needs a finished 'jobId' or a non-empty 'items' list"}
        status, body = _post_json(port, "/cuts/apply", {"jobId": "req_nope"})
        assert status == 404
        assert body == {"error": "job 'req_nope' is unknown"}
        status, body = _post_json(port, "/cuts/apply", {"jobId": queued.request_id})
        assert status == 409
        assert isinstance(body["error"], str) and "queued" in body["error"]
    finally:
        _stop(server, thread, old)


def test_cuts_apply_never_200_when_nothing_lands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    _install_cut_resolve(monkeypatch, _project())
    written: list = []
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        status, body = _post_json(port, "/cuts/apply", {"items": _cut_ops()[2:]})
        assert status == 400
        assert body == {"error": "the request holds no cut items to apply"}
        from chair_agent.edit_ops import trim_op

        lost = trim_op("trim-lost", "uid-nope", "Trim a ghost.", start_frames=4)
        status, body = _post_json(port, "/cuts/apply", {
            "items": [lost.model_dump(mode="json", by_alias=True)],
        })
        assert status == 502
        assert body["error"].startswith("Resolve added nothing: ")
        assert "names no clip on the copy" in body["error"]
        assert written == []
    finally:
        _stop(server, thread, old)


def test_cuts_undo_redo_and_health_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    project = _project()
    project.timelines.append(_FakeCutTimeline("Timeline 1 (cut copy)"))
    _install_cut_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    job = controller.submit("edit", {"brief": "trim"})
    controller.claim_next()
    controller.finish_completed(job.request_id, ops=_cut_ops()[:1])
    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        _, health = _get_json(port, "/health")
        assert health["cuts"] == {
            "landed": 0, "undone": 0, "skipped_ops": 0,
            "last_error": None, "last_write_ms": None,
        }
        status, _ = _post_json(port, "/cuts/apply", {"jobId": job.request_id})
        assert status == 200
        project.current = project.timelines[1]  # the land made the copy current
        status, undone = _post_json(port, "/cuts/undo", {
            "timeline_name": "Timeline 1 (cut copy)",
            "original_timeline": "Timeline 1",
        })
        assert status == 200
        assert undone == {"current_timeline": "Timeline 1", "deleted": False}
        assert project.current.GetName() == "Timeline 1"
        assert project.deleted == []
        # Redo lands the copy again under a fresh suffixed name.
        status, redone = _post_json(port, "/cuts/apply", {"jobId": job.request_id})
        assert status == 200
        assert redone["timeline_name"] == "Timeline 1 (cut copy) 2"
        _, health = _get_json(port, "/health")
        assert health["cuts"]["landed"] == 2
        assert health["cuts"]["undone"] == 1
        assert health["cuts"]["skipped_ops"] == 0
        assert health["cuts"]["last_error"] is None
        assert isinstance(health["cuts"]["last_write_ms"], float)
        # A failed apply records the last error without counting a land.
        from chair_agent.edit_ops import trim_op

        lost = trim_op("trim-lost", "uid-nope", "Trim a ghost.", start_frames=4)
        status, _ = _post_json(port, "/cuts/apply", {
            "items": [lost.model_dump(mode="json", by_alias=True)],
        })
        assert status == 502
        _, health = _get_json(port, "/health")
        assert health["cuts"]["landed"] == 2
        assert health["cuts"]["last_error"].startswith("Resolve added nothing: ")
    finally:
        _stop(server, thread, old)


def test_cuts_undo_deletes_the_copy_only_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent.jobs import JobController

    project = _project()
    project.timelines.append(_FakeCutTimeline("Timeline 1 (cut copy)"))
    _install_cut_resolve(monkeypatch, project)
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve(controller)
    try:
        port = server.server_address[1]
        status, undone = _post_json(port, "/cuts/undo", {
            "timeline_name": "Timeline 1 (cut copy)",
            "original_timeline": "Timeline 1",
            "delete_copy": True,
        })
        assert status == 200
        assert undone == {"current_timeline": "Timeline 1", "deleted": True}
        assert [t.GetName() for t in project.deleted] == ["Timeline 1 (cut copy)"]
        status, body = _post_json(port, "/cuts/undo", {
            "timeline_name": "Timeline 1",
            "original_timeline": "Timeline 1",
            "delete_copy": True,
        })
        assert status == 400
        assert body == {"error": "undo refuses to delete the original timeline"}
    finally:
        _stop(server, thread, old)
