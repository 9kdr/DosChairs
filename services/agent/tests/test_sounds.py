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
    gains = [item for item in changeset.items if item.op == "set_gain"]
    assert len(gains) == len(clips)
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
