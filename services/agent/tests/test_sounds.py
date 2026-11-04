"""Sound library index, cue picking, and sounds HTTP endpoints (#226)."""

import json
import math
import struct
import threading
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent import sounds
from chair_agent.__main__ import Handler
from chair_agent.client import Completion
from chair_agent.edit_ops import validate_changeset


def _wav(path: Path, seconds: float = 0.5, freq: float = 440.0) -> None:
    rate = 22050
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            sample = int(10000 * math.sin(2 * math.pi * freq * i / rate))
            handle.writeframes(struct.pack("<h", sample))


@pytest.fixture()
def library(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    root = tmp_path / "mine"
    root.mkdir()
    _wav(root / "tape-stop-hit.wav")
    _wav(root / "big-riser.wav", freq=880.0)
    _wav(root / "whoosh-fast.wav", seconds=0.25, freq=220.0)
    (root / "notes.txt").write_text("not audio")
    monkeypatch.setenv("CHAIR_SOUNDS_DIR", str(root))
    monkeypatch.setenv("CHAIR_SOUNDS_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("CHAIR_SPLICE_DIR", raising=False)
    monkeypatch.delenv("FREESOUND_API_KEY", raising=False)
    sounds._INDEX_CACHE["entries"] = []
    sounds._STATUS.update({"last_pick_at": None, "last_error": None})
    return root


def test_scan_tags_and_durations(library: Path) -> None:
    entries = sounds.refresh_library()
    assert len(entries) == 3
    by_name = {entry.name: entry for entry in entries}
    assert by_name["tape-stop-hit.wav"].tags == ["hit", "stop", "tape"]
    assert by_name["big-riser.wav"].tags == ["riser"]
    assert by_name["whoosh-fast.wav"].tags == ["whoosh"]
    assert all(entry.source == "own" for entry in entries)
    assert by_name["tape-stop-hit.wav"].duration == pytest.approx(0.5, abs=0.01)
    assert all(entry.loudness_lufs is None for entry in entries)  # lazy until asked
    assert sounds.probe_duration(library / "tape-stop-hit.wav") == pytest.approx(0.5, abs=0.01)


def test_rules_pick_lands_on_beat_with_reasons(library: Path) -> None:
    entries = sounds.refresh_library()
    context = sounds.CueContext(cuts=[2.0], beats=[1.0, 2.0, 3.0], words=[])
    cues, picker = sounds.pick_cues("tape stop at the hard cut", context, entries)
    assert picker == "rules"
    assert cues, "a tape-stop brief against a tagged library must propose a cue"
    cue = cues[0]
    assert cue.kind == "tape-stop"
    assert cue.start_seconds == pytest.approx(2.0)
    assert cue.gain_db <= 0
    assert cue.reason.strip() and "\n" not in cue.reason.strip()
    changeset = sounds.cues_to_changeset(
        cues, entries, changeset_id="cs-1", base_revision="rev-0",
    )
    validate_changeset(changeset.model_dump(mode="json", by_alias=True, exclude_none=True))
    ops = [item.op for item in changeset.items]
    assert ops[0] == "add_track"
    clips = [item for item in changeset.items if item.op == "add_clip"]
    assert clips and all(item.target_id == "audio-sfx-1" for item in clips)
    # No track-targeted set_gain: the gain rides on each clip snapshot.
    assert [item.op for item in changeset.items].count("set_gain") == 0
    snapshot = clips[0].patch["clip"]
    assert snapshot["mediaRef"].endswith(".wav")
    assert snapshot["timelineRange"]["start"]["value"] >= 0
    assert clips[0].patch["gainDb"] == cues[0].gain_db
    assert clips[0].patch["kind"] == "tape-stop"
    assert all(item.status == "pending" for item in changeset.items)


def test_rules_pre_hit_ends_on_the_moment(library: Path) -> None:
    entries = sounds.refresh_library()
    by_id = {entry.id: entry for entry in entries}
    context = sounds.CueContext(cuts=[2.0], beats=[1.0, 2.0, 3.0], words=[])
    cues, _ = sounds.pick_cues("riser build into the downbeat", context, entries)
    assert cues and cues[0].kind == "riser"
    duration = by_id[cues[0].entry_id].duration or 1.0
    assert cues[0].start_seconds == pytest.approx(2.0 - duration, abs=0.01)
    assert cues[0].start_seconds + duration == pytest.approx(2.0, abs=0.01)


def test_rules_no_stacked_transients_on_one_moment(library: Path) -> None:
    entries = sounds.refresh_library()
    context = sounds.CueContext(cuts=[2.0], beats=[2.0], words=[])
    cues, _ = sounds.pick_cues(
        "tape stop at the hard cut, then a riser build into it", context, entries,
    )
    kinds = {cue.kind for cue in cues}
    assert "tape-stop" in kinds
    assert not ({"tape-stop", "riser"} <= kinds), \
        "one moment holds one transient: the riser must move on or drop"
    by_id = {entry.id: entry for entry in entries}
    transients = [
        cue.start_seconds + (by_id[cue.entry_id].duration or 1.0)
        if cue.kind in ("riser", "reverse-swell", "whoosh")
        else cue.start_seconds
        for cue in cues
    ]
    for first in range(len(transients)):
        for second in range(first + 1, len(transients)):
            assert abs(transients[first] - transients[second]) > 0.1


def test_model_cues_are_normalized_not_stacked(library: Path) -> None:
    entries = sounds.refresh_library()
    by_id = {entry.id: entry for entry in entries}
    riser = next(e for e in entries if "riser" in e.tags)
    hit = next(e for e in entries if "tape" in e.tags)

    class FakeClient:
        def execute(self, messages):
            return Completion(model="muse-spark-1", text=json.dumps([
                {"entry_id": riser.id, "kind": "riser",
                 "start_seconds": 3.0, "gain_db": -10.0,
                 "reason": "Riser into the downbeat at 3.00s."},
                {"entry_id": hit.id, "kind": "tape-stop",
                 "start_seconds": 3.0, "gain_db": -10.0,
                 "reason": "Tape-stop on the same downbeat at 3.00s."},
            ]))

    context = sounds.CueContext(cuts=[3.0], beats=[3.0], words=[])
    cues, picker = sounds.pick_cues(
        "riser and tape stop on the downbeat", context, entries, client=FakeClient(),  # type: ignore[arg-type]
    )
    assert picker == "model"
    assert len(cues) == 1, "the stacked transient must be dropped"
    assert cues[0].kind == "riser"
    duration = by_id[cues[0].entry_id].duration or 1.0
    assert cues[0].start_seconds == pytest.approx(3.0 - duration, abs=0.01)


def test_rules_pick_leaves_dialogue_clear(library: Path) -> None:
    entries = sounds.refresh_library()
    words = [{"word": "hello", "start": 1.9, "end": 2.4}]
    context = sounds.CueContext(cuts=[2.0], beats=[1.0, 2.0, 3.0], words=words)
    cues, _ = sounds.pick_cues("tape stop at the hard cut", context, entries)
    by_id = {entry.id: entry for entry in entries}
    for cue in cues:
        duration = by_id[cue.entry_id].duration or 1.0
        assert not (
            cue.start_seconds < 2.4 and cue.start_seconds + duration > 1.9
        ), "no cue may cover a transcript word span"


def test_freesound_search_is_cc0_only_with_attribution() -> None:
    payload = {"results": [{
        "id": 42, "name": "soft riser", "duration": 1.25,
        "license": "Creative Commons 0",
        "previews": {"preview-hq-mp3": "https://cdn.example/r.mp3"},
        "username": "mel", "url": "https://freesound.org/s/42/",
    }]}
    seen: list = []

    class FakeResponse:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return json.dumps(payload).encode()

    def fake_urlopen(request, timeout=30):
        seen.append(request)
        return FakeResponse()

    entries = sounds.search_freesound("riser", "key-123", opener=fake_urlopen)
    assert len(entries) == 1
    entry = entries[0]
    assert entry.source == "freesound"
    assert entry.license == "Creative Commons 0"
    assert entry.preview_url == "https://cdn.example/r.mp3"
    assert "mel" in (entry.attribution or "")
    assert 'license' in seen[0].full_url
    assert "Token key-123" in seen[0].headers.values()


def test_model_pick_parses_completion(library: Path) -> None:
    entries = sounds.refresh_library()
    first = entries[0]

    class FakeClient:
        def execute(self, messages):
            assert any(sounds.TASTE_GUIDE.split(".")[0][:20] in m.content
                       for m in messages if m.role == "developer")
            return Completion(model="muse-spark-1", text=json.dumps([{
                "entry_id": first.id, "kind": "impact",
                "start_seconds": 3.0, "gain_db": -14.0,
                "reason": "Impact lands on the downbeat at 3.00s.",
            }]))

    context = sounds.CueContext(cuts=[3.0], beats=[3.0], words=[])
    cues, picker = sounds.pick_cues(
        "big impact on the downbeat", context, entries, client=FakeClient(),  # type: ignore[arg-type]
    )
    assert picker == "model"
    assert len(cues) == 1
    assert cues[0].entry_id == first.id


def test_model_failure_falls_back_and_records_error(library: Path) -> None:
    entries = sounds.refresh_library()

    class BrokenClient:
        def execute(self, messages):
            raise RuntimeError("no key, no model")

    context = sounds.CueContext(cuts=[2.0], beats=[2.0], words=[])
    cues, picker = sounds.pick_cues(
        "riser into the downbeat", context, entries, client=BrokenClient(),  # type: ignore[arg-type]
    )
    assert picker == "rules-fallback"
    assert cues
    snapshot = sounds.status_snapshot()
    assert snapshot["last_pick_at"] is not None
    assert "no key" in (snapshot["last_error"] or "")


def test_http_lists_searches_picks_and_reports_health(
    library: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sounds._INDEX_CACHE["entries"] = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urlopen(f"http://127.0.0.1:{port}/sounds") as response:
            listed = json.load(response)
        assert listed["counts"] == {"own": 3, "splice": 0, "freesound": 0}
        assert len(listed["sounds"]) == 3

        with urlopen(f"http://127.0.0.1:{port}/sounds?q=riser") as response:
            assert [s["name"] for s in json.load(response)["sounds"]] == ["big-riser.wav"]
        with urlopen(f"http://127.0.0.1:{port}/sounds?tag=whoosh") as response:
            assert [s["name"] for s in json.load(response)["sounds"]] == ["whoosh-fast.wav"]

        pick = Request(
            f"http://127.0.0.1:{port}/sounds/pick",
            data=json.dumps({
                "brief": "tape stop at the hard cut",
                "cuts": [2.0], "beats": [1.0, 2.0, 3.0], "words": [],
                "changeset_id": "cs-http", "base_revision": "rev-http",
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(pick) as response:
            proposed = json.load(response)
        assert proposed["picker"] == "rules"
        assert proposed["changeset"]["baseRevision"] == "rev-http"
        ops = [item["op"] for item in proposed["changeset"]["items"]]
        assert ops[0] == "add_track" and "add_clip" in ops

        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            health = json.load(response)
        assert health["sounds"]["counts"] == {"own": 3, "splice": 0, "freesound": 0}
        assert health["sounds"]["last_pick_at"] is not None
        assert health["sounds"]["last_error"] is None
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_splice_folder_is_tagged_splice(
    library: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    splice = tmp_path / "packs"
    splice.mkdir()
    _wav(splice / "deep-impact-pack.wav")
    monkeypatch.setenv("CHAIR_SPLICE_DIR", str(splice))
    sounds._INDEX_CACHE["entries"] = []
    entries = sounds.refresh_library()
    tagged = [e for e in entries if e.source == "splice"]
    assert len(tagged) == 1
    assert set(tagged[0].tags) == {"impact"}
    assert sounds.status_snapshot()["counts"] == {"own": 3, "splice": 1, "freesound": 0}


def test_cues_changeset_places_through_the_resolve_writer(library: Path) -> None:
    """cues_to_changeset output is the executor shape: the writer places it all."""
    from chair_resolve.write import apply_sound_items

    entries = sounds.refresh_library()
    context = sounds.CueContext(cuts=[2.0], beats=[1.0, 2.0, 3.0], words=[])
    cues, _ = sounds.pick_cues("tape stop at the hard cut", context, entries)
    assert cues
    changeset = sounds.cues_to_changeset(
        cues, entries, changeset_id="cs-writer", base_revision="rev-0",
    )
    timeline = {
        "id": "t-1", "name": "Timeline 1", "rate": {"num": 30, "den": 1},
        "tracks": [], "markers": [],
    }
    dumped = [
        item.model_dump(mode="json", by_alias=True, exclude_none=True)
        for item in changeset.items
    ]
    copy, report = apply_sound_items(timeline, dumped)
    assert report["tracks_added"] == ["audio-sfx-1"]
    assert len(report["clips_placed"]) == len(cues)
    assert report["skipped"] == []
    assert timeline["tracks"] == []


def test_empty_library_fails_instead_of_an_empty_track() -> None:
    with pytest.raises(ValueError, match="no sounds in the library"):
        sounds.cues_to_changeset(
            [], [], changeset_id="cs-empty", base_revision="rev-0",
        )


def test_pick_with_empty_library_is_a_plain_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent.__main__ import _sounds_pick_body

    monkeypatch.setattr(sounds, "get_library", lambda *args, **kwargs: [])
    monkeypatch.setattr("chair_agent.__main__._cue_client", lambda: None)
    with pytest.raises(ValueError, match="no sounds in the library"):
        _sounds_pick_body({"brief": "riser", "cuts": [], "beats": [], "words": []})


class _FakeSoundItem:
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


class _FakeSoundTimeline:
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
        return 1 if kind == "audio" else 0

    def GetItemListInTrack(self, kind: str, index: int):
        return list(self._items) if kind == "audio" and index == 1 else []

    def GetTrackName(self, kind: str, index: int) -> str:
        return "Audio 1"

    def GetMarkers(self) -> dict:
        return {}


class _FakeSoundProject:
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


def _install_sound_resolve(monkeypatch: pytest.MonkeyPatch, project) -> None:
    import sys as _sys
    import types as _types

    manager = _types.SimpleNamespace(GetCurrentProject=lambda: project)
    bmd = _types.ModuleType("DaVinciResolveScript")
    bmd.scriptapp = lambda name: _types.SimpleNamespace(GetProjectManager=lambda: manager)
    monkeypatch.setitem(_sys.modules, "DaVinciResolveScript", bmd)


def _sound_ops() -> list:
    from chair_agent.edit_ops import duck_op, sfx_clip_op, sfx_track_op

    return [
        item.model_dump(mode="json", by_alias=True)
        for item in [
            sfx_track_op("track-sfx-1", "New audio track for sound cues."),
            sfx_clip_op(
                "sfx-riser-1", "audio-sfx-1", "sfx-riser-1", "riser lands on 5s.",
                media_ref="/sfx/riser.wav", name="riser.wav",
                start_seconds=3.0, duration_seconds=2.0,
            ),
            duck_op(
                "duck-1", "uid-music", "Duck music under dialogue.",
                regions_seconds=[(0.0, 2.0)],
            ),
        ]
    ]


def _serve_sounds_apply(controller):
    old = getattr(Handler, "controller", None)
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, old


def _stop_sounds_apply(server, thread, old) -> None:
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


def test_sounds_apply_writes_a_named_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    music = _FakeSoundItem("music.wav", 0, 600, "/media/music.wav")
    original = _FakeSoundTimeline("Timeline 1", [music])
    project = _FakeSoundProject("Chair Captest", [original])
    _install_sound_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "apply_sound_items",
        lambda timeline, items: (
            dict(timeline),
            {"tracks_added": ["audio-sfx-1"], "clips_placed": ["sfx-riser-1"],
             "keyframes": 4, "skipped": [],
             "fallbacks": [{"id": "duck-1", "reason": "set the Fairlight keyframes by hand"}]},
        ),
    )
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    job = controller.submit("edit", {"brief": "riser at 5s, duck music"})
    controller.claim_next()
    controller.finish_completed(job.request_id, ops=_sound_ops())

    server, thread, old = _serve_sounds_apply(controller)
    try:
        port = server.server_address[1]
        status, applied = _post_json(port, "/sounds/apply", {
            "jobId": job.request_id, "project": "Chair Captest",
        })
        assert status == 200
        assert applied["timeline_name"] == "Timeline 1 (sound copy)"
        assert applied["original_timeline"] == "Timeline 1"
        assert applied["tracks_added"] == 1
        assert applied["clips_added"] == 1
        assert applied["skipped"] == []
        assert applied["fallback"] == "set the Fairlight keyframes by hand"
        assert len(written) == 1
        assert written[0]["name"] == "Timeline 1 (sound copy)"
    finally:
        _stop_sounds_apply(server, thread, old)


def test_sounds_apply_suffixes_a_taken_copy_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    original = _FakeSoundTimeline("Timeline 1")
    taken = _FakeSoundTimeline("Timeline 1 (sound copy)")
    project = _FakeSoundProject("Chair Captest", [original, taken])
    _install_sound_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "apply_sound_items",
        lambda timeline, items: (
            dict(timeline),
            {"tracks_added": ["audio-sfx-1"], "clips_placed": [], "keyframes": 0,
             "skipped": [], "fallbacks": []},
        ),
    )
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve_sounds_apply(controller)
    try:
        port = server.server_address[1]
        status, applied = _post_json(port, "/sounds/apply", {"items": _sound_ops()[:1]})
        assert status == 200
        assert applied["timeline_name"] == "Timeline 1 (sound copy) 2"
        assert applied["fallback"] is None
        assert written[0]["name"] == "Timeline 1 (sound copy) 2"
    finally:
        _stop_sounds_apply(server, thread, old)


def test_sounds_apply_errors_are_plain_sentences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent.jobs import JobController

    project = _FakeSoundProject("Chair Captest", [_FakeSoundTimeline("Timeline 1")])
    _install_sound_resolve(monkeypatch, project)
    controller = JobController(tmp_path / "jobs.json")
    queued = controller.submit("edit", {"brief": "riser"})
    server, thread, old = _serve_sounds_apply(controller)
    try:
        port = server.server_address[1]
        status, body = _post_json(port, "/sounds/apply", {})
        assert status == 400
        assert body == {"error": "apply needs a finished 'jobId' or a non-empty 'items' list"}
        status, body = _post_json(port, "/sounds/apply", {"jobId": "req_nope"})
        assert status == 404
        assert body == {"error": "job 'req_nope' is unknown"}
        status, body = _post_json(port, "/sounds/apply", {"jobId": queued.request_id})
        assert status == 409
        assert isinstance(body["error"], str) and "queued" in body["error"]
    finally:
        _stop_sounds_apply(server, thread, old)


def test_sounds_apply_never_200_when_nothing_lands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.write as resolve_write
    from chair_agent.jobs import JobController

    project = _FakeSoundProject("Chair Captest", [_FakeSoundTimeline("Timeline 1")])
    _install_sound_resolve(monkeypatch, project)
    written: list = []
    monkeypatch.setattr(
        resolve_write, "apply_sound_items",
        lambda timeline, items: (
            dict(timeline),
            {"tracks_added": [], "clips_placed": [], "keyframes": 0,
             "skipped": [{"id": "duck-1", "reason": "Duck 'duck-1' names no clip on the copy."}],
             "fallbacks": []},
        ),
    )
    monkeypatch.setattr(
        resolve_write, "write_timeline", lambda timeline: written.append(timeline),
    )
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve_sounds_apply(controller)
    try:
        port = server.server_address[1]
        status, body = _post_json(port, "/sounds/apply", {"items": _sound_ops()})
        assert status == 502
        assert body["error"].startswith("Resolve added nothing: ")
        assert "names no clip on the copy" in body["error"]
        assert written == []
    finally:
        _stop_sounds_apply(server, thread, old)


def test_sounds_undo_restores_and_optionally_deletes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent.jobs import JobController

    original = _FakeSoundTimeline("Timeline 1")
    copy = _FakeSoundTimeline("Timeline 1 (sound copy)")
    project = _FakeSoundProject("Chair Captest", [original, copy])
    project.current = copy
    _install_sound_resolve(monkeypatch, project)
    controller = JobController(tmp_path / "jobs.json")
    server, thread, old = _serve_sounds_apply(controller)
    try:
        port = server.server_address[1]
        status, undone = _post_json(port, "/sounds/undo", {
            "timeline_name": "Timeline 1 (sound copy)",
            "original_timeline": "Timeline 1",
        })
        assert status == 200
        assert undone == {"current_timeline": "Timeline 1", "deleted": False}
        assert project.current is original
        assert project.deleted == []
        status, undone = _post_json(port, "/sounds/undo", {
            "timeline_name": "Timeline 1 (sound copy)",
            "original_timeline": "Timeline 1",
            "delete_copy": True,
        })
        assert status == 200
        assert undone == {"current_timeline": "Timeline 1", "deleted": True}
        assert project.deleted == [copy]
        status, body = _post_json(port, "/sounds/undo", {
            "timeline_name": "Timeline 1",
            "original_timeline": "Timeline 1",
            "delete_copy": True,
        })
        assert status == 400
        assert body == {"error": "undo refuses to delete the original timeline"}
    finally:
        _stop_sounds_apply(server, thread, old)
