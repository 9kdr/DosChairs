import array
import hashlib
import json
import math
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_sidecar import music
from chair_sidecar.__main__ import SidecarServer
from chair_sidecar.jobs import (
    JobKind,
    JobStore,
    MediaRequest,
    MusicRequest,
    Sam3Request,
    SamAudioRequest,
    active_spans,
    default_proxy_dir,
    parse_ebur128,
    parse_progress,
    parse_runner_progress,
    parse_scene_cuts,
    parse_silence,
)
from pydantic import ValidationError


def test_job_kinds() -> None:
    assert JobKind.SAM3_MASK.value == "sam3_mask"


def test_progress_uses_out_time_us() -> None:
    assert parse_progress("out_time_us=500000\n", 1.0) == 0.5
    assert parse_progress("out_time_ms=500000\n", 1.0) is None
    assert parse_progress("out_time_us=2000000\n", 1.0) == 0.99


def test_runner_progress_lines_move_the_job() -> None:
    assert parse_runner_progress("progress=0.5\n") == 0.5
    assert parse_runner_progress("frame=12\n") is None
    assert parse_runner_progress("progress=2\n") == 0.99
    assert parse_runner_progress("progress=banana\n") is None


def test_sam3_request_needs_a_prompt_matching_its_kind() -> None:
    with pytest.raises(ValidationError, match="source is required"):
        Sam3Request.model_validate({"source": "  ", "prompt": "the speaker"})
    with pytest.raises(ValidationError, match="text prompts need prompt"):
        Sam3Request.model_validate({"source": "clip.mp4", "prompt_kind": "text"})
    with pytest.raises(ValidationError, match="point prompts need point"):
        Sam3Request.model_validate({"source": "clip.mp4", "prompt_kind": "point"})
    with pytest.raises(ValidationError, match="within 0..1"):
        Sam3Request.model_validate(
            {"source": "clip.mp4", "prompt_kind": "point", "point": [1.5, 0.5]}
        )
    text = Sam3Request.model_validate(
        {"source": "clip.mp4", "prompt_kind": "text", "prompt": "the speaker"}
    )
    assert text.prompt_payload() == {"kind": "text", "prompt": "the speaker"}
    point = Sam3Request.model_validate(
        {"source": "clip.mp4", "prompt_kind": "point", "point": [0.5, 0.4]}
    )
    assert point.prompt_payload() == {"kind": "point", "point": [0.5, 0.4]}


def test_sam_audio_request_needs_a_prompt_matching_its_kind() -> None:
    with pytest.raises(ValidationError, match="source is required"):
        SamAudioRequest.model_validate({"source": "  ", "prompt": "the speaker"})
    with pytest.raises(ValidationError, match="text prompts need prompt"):
        SamAudioRequest.model_validate({"source": "clip.mp4", "prompt_kind": "text"})
    with pytest.raises(ValidationError, match="span prompts need span"):
        SamAudioRequest.model_validate({"source": "clip.mp4", "prompt_kind": "span"})
    with pytest.raises(ValidationError, match="span must run forward"):
        SamAudioRequest.model_validate(
            {"source": "clip.mp4", "prompt_kind": "span", "span": [1.0, 0.5]}
        )
    with pytest.raises(ValidationError, match="span must run forward"):
        SamAudioRequest.model_validate(
            {"source": "clip.mp4", "prompt_kind": "span", "span": [-0.5, 0.5]}
        )
    text = SamAudioRequest.model_validate(
        {"source": "clip.mp4", "prompt_kind": "text", "prompt": "the speaker"}
    )
    assert text.prompt_payload() == {
        "kind": "text",
        "prompt": "the speaker",
        "mode": "isolate",
    }
    span = SamAudioRequest.model_validate(
        {
            "source": "clip.mp4",
            "prompt_kind": "span",
            "span": [0.2, 0.8],
            "mode": "remove",
        }
    )
    assert span.prompt_payload() == {
        "kind": "span",
        "span": [0.2, 0.8],
        "mode": "remove",
    }


def test_loudness_parser_uses_the_summary() -> None:
    log = """
    I: -70.0 LUFS
    Summary:
      Integrated loudness:
        I:         -21.8 LUFS
        Threshold: -31.8 LUFS
      Loudness range:
        LRA:         0.0 LU
      True peak:
        Peak:      -16.3 dBFS
    """
    assert parse_ebur128(log) == {
        "integrated_lufs": -21.8,
        "loudness_range_lu": 0.0,
        "true_peak_dbfs": -16.3,
    }


def test_scene_cuts_keep_interior_times_only() -> None:
    log = """
[out #0/null @ 0x1] video:0kB audio:0kB
[Parsed_showinfo_1 @ 0x1] n: 0 pts: 0 pts_time:0 pos: 1
[Parsed_showinfo_1 @ 0x1] n: 5 pts: 5 pts_time:0.5 pos: 2
[Parsed_showinfo_1 @ 0x1] n: 5 pts: 5 pts_time:0.5004 pos: 3
[Parsed_showinfo_1 @ 0x1] n: 9 pts: 9 pts_time:0.9 pos: 4
[Parsed_showinfo_1 @ 0x1] n: 10 pts: 10 pts_time:1 pos: 5
[out_time_us=900000]
"""
    assert parse_scene_cuts(log, 1.0) == [0.5, 0.9]
    assert parse_scene_cuts(log, 1.0, min_shot=0.5) == [0.5]
    assert parse_scene_cuts("no cuts here\n", 1.0) == []


def test_scene_request_validates_its_thresholds() -> None:
    with pytest.raises(ValidationError, match="between 0 and 1"):
        MediaRequest.model_validate({"source": "clip.mp4", "threshold": 1.5})
    with pytest.raises(ValidationError, match="between 0 and 1"):
        MediaRequest.model_validate({"source": "clip.mp4", "threshold": -0.1})
    with pytest.raises(ValidationError, match="min_shot must be >= 0"):
        MediaRequest.model_validate({"source": "clip.mp4", "min_shot": -0.5})
    request = MediaRequest.model_validate(
        {"source": "clip.mp4", "threshold": 0.3, "min_shot": 0.2}
    )
    assert (request.threshold, request.min_shot) == (0.3, 0.2)


def test_silence_spans_leave_the_active_parts() -> None:
    log = "silence_start: 0\nsilence_end: 0.4\nsilence_start: 1.5\n"
    silence = parse_silence(log, 2.0)
    assert silence == [{"start": 0.0, "end": 0.4}, {"start": 1.5, "end": 2.0}]
    assert active_spans(silence, 2.0) == [{"start": 0.4, "end": 1.5}]


def test_proxy_dir_defaults_under_chair_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CHAIR_PROXY_DIR", raising=False)
    monkeypatch.setenv("CHAIR_ROOT", str(tmp_path))
    assert default_proxy_dir() == (tmp_path / "data" / "proxies").resolve()


def test_proxy_dir_follows_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHAIR_PROXY_DIR", "data/proxies")
    assert default_proxy_dir() == (tmp_path / "data" / "proxies").resolve()


class _RecordingStore(JobStore):
    def __init__(self, proxy_dir: Path) -> None:
        super().__init__(proxy_dir)
        self.seen: list[float] = []

    def _update(self, job_id: str, **fields: object) -> None:
        progress = fields.get("progress")
        if isinstance(progress, float):
            self.seen.append(progress)
        super()._update(job_id, **fields)


@pytest.fixture(scope="module")
def source_media(tmp_path_factory: pytest.TempPathFactory) -> Path:
    dest = tmp_path_factory.mktemp("clip") / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest


@pytest.fixture(scope="module")
def two_shot_media(tmp_path_factory: pytest.TempPathFactory) -> Path:
    dest = tmp_path_factory.mktemp("two_shot") / "two_shot.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=320x240:rate=10:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "color=blue:size=320x240:rate=10:duration=0.5",
            "-filter_complex",
            "[0][1]concat=n=2:v=1:a=0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest


@pytest.fixture
def proxy_dir(tmp_path: Path) -> Path:
    path = tmp_path / "proxies"
    path.mkdir()
    return path


@pytest.fixture
def store(proxy_dir: Path) -> _RecordingStore:
    return _RecordingStore(proxy_dir)


@pytest.fixture
def server(store: _RecordingStore):
    httpd = SidecarServer(("127.0.0.1", 0), store)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield base
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def fake_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    script = tmp_path / "fake-sam3"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import argparse, json, subprocess, sys\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--source')\n"
        "parser.add_argument('--prompt')\n"
        "parser.add_argument('--output')\n"
        "args = parser.parse_args()\n"
        "prompt = json.loads(args.prompt)\n"
        "assert prompt['kind'] in ('text', 'point'), prompt\n"
        "print('progress=0.2', file=sys.stderr, flush=True)\n"
        "subprocess.run(\n"
        "    ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',\n"
        "     '-i', args.source, '-vf', 'format=gray', '-c:v', 'libx264',\n"
        "     '-pix_fmt', 'yuv420p', '-an', args.output],\n"
        "    check=True,\n"
        ")\n"
        "print('progress=0.9', file=sys.stderr, flush=True)\n"
    )
    script.chmod(0o755)
    monkeypatch.setenv("CHAIR_SAM3_RUNNER", str(script))
    return str(script)


@pytest.fixture
def fake_audio_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    script = tmp_path / "fake-sam-audio"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import argparse, json, subprocess, sys\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--source')\n"
        "parser.add_argument('--prompt')\n"
        "parser.add_argument('--output')\n"
        "args = parser.parse_args()\n"
        "prompt = json.loads(args.prompt)\n"
        "assert prompt['kind'] in ('text', 'span'), prompt\n"
        "assert prompt['mode'] in ('isolate', 'remove'), prompt\n"
        "print('progress=0.2', file=sys.stderr, flush=True)\n"
        "subprocess.run(\n"
        "    ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',\n"
        "     '-i', args.source, '-map', '0:a:0', '-c:a', 'pcm_s16le',\n"
        "     args.output],\n"
        "    check=True,\n"
        ")\n"
        "print('progress=0.9', file=sys.stderr, flush=True)\n"
    )
    script.chmod(0o755)
    monkeypatch.setenv("CHAIR_SAM_AUDIO_RUNNER", str(script))
    return str(script)


def _request(method: str, url: str, payload: dict | None = None) -> tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {} if data is None else {"content-type": "application/json"}
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except HTTPError as exc:
        return exc.code, json.load(exc)


def _wait(base: str, job_id: str) -> dict:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, body = _request("GET", f"{base}/jobs/{job_id}")
        assert status == 200
        if body["status"] in {"done", "failed"}:
            return body
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _streams(path: Path) -> list[dict]:
    raw = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            str(path),
        ],
        text=True,
    )
    return json.loads(raw)["streams"]


def test_health_lists_job_kinds(server: str) -> None:
    status, body = _request("GET", f"{server}/health")
    assert status == 200
    assert body["ok"] is True
    assert "measure_audio" in body["jobs"]
    assert "sam3_mask" in body["jobs"]
    assert "analyze_music" in body["jobs"]
    assert "sam_audio" in body["jobs"]
    assert "scene_cuts" in body["jobs"]
    assert isinstance(body["sam3_runner"], bool)
    assert isinstance(body["sam_audio_runner"], bool)


def test_render_preview_writes_a_cached_proxy(
    server: str,
    store: _RecordingStore,
    proxy_dir: Path,
    source_media: Path,
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/render_preview",
        {"source": str(source_media)},
    )
    assert status == 202
    assert queued["tool"] == "render_preview"
    assert queued["kind"] == "proxy"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    proxy = Path(result["proxy"])
    assert result["preset"] == "preview-640"
    assert result["cached"] is False
    assert result["width"] == 640
    assert proxy.is_relative_to(proxy_dir)
    assert proxy != source_media
    assert _sha256(source_media) == digest
    kinds = {stream["codec_type"] for stream in _streams(proxy)}
    assert {"video", "audio"} <= kinds
    again = _wait(
        server,
        _request("POST", f"{server}/jobs/render_preview", {"source": str(source_media)})[1]["id"],
    )
    assert again["result"]["cached"] is True
    assert again["result"]["proxy"] == str(proxy)
    assert _sha256(source_media) == digest
    assert list(source_media.parent.glob("*.part.mp4")) == []


def test_get_frame_extracts_one_picture(
    server: str,
    proxy_dir: Path,
    source_media: Path,
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/get_frame",
        {"source": str(source_media), "time": 0.25},
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    frame = Path(job["result"]["frame"])
    assert job["result"]["time"] == 0.25
    assert job["result"]["width"] == 320
    assert job["result"]["height"] == 240
    assert frame.is_relative_to(proxy_dir)
    assert frame.read_bytes().startswith(b"\xff\xd8")
    assert _streams(frame)[0]["codec_type"] == "video"
    assert _sha256(source_media) == digest
    assert list(source_media.parent.glob("*.jpg")) == []


def test_measure_audio_reports_loudness(
    server: str,
    store: _RecordingStore,
    source_media: Path,
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/measure_audio",
        {"source": str(source_media)},
    )
    assert status == 202
    assert queued["kind"] == "measure_audio"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    assert -50 < result["integrated_lufs"] < 0
    assert result["loudness_range_lu"] >= 0
    assert -60 < result["true_peak_dbfs"] <= 0
    assert result["active"][0]["end"] > 0.5
    assert isinstance(result["silence"], list)
    assert _sha256(source_media) == digest


def test_detect_scenes_returns_cut_times_only(
    server: str,
    store: _RecordingStore,
    source_media: Path,
    two_shot_media: Path,
) -> None:
    digest = _sha256(two_shot_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/detect_scenes",
        {"source": str(two_shot_media)},
    )
    assert status == 202
    assert queued["tool"] == "detect_scenes"
    assert queued["kind"] == "scene_cuts"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    assert set(result) == {"cuts", "duration", "threshold", "min_shot"}
    assert result["cuts"] == pytest.approx([0.5])
    assert result["duration"] == pytest.approx(1.0)
    assert result["threshold"] == 0.4
    assert result["min_shot"] == 0.0
    assert result["cuts"] == sorted(set(result["cuts"]))
    assert all(0 < cut < result["duration"] for cut in result["cuts"])
    assert _sha256(two_shot_media) == digest

    tuned = _wait(
        server,
        _request(
            "POST",
            f"{server}/jobs/detect_scenes",
            {"source": str(two_shot_media), "threshold": 0.3, "min_shot": 0.2},
        )[1]["id"],
    )
    assert tuned["status"] == "done", tuned["error"]
    assert tuned["result"]["cuts"] == pytest.approx([0.5])
    assert tuned["result"]["threshold"] == 0.3
    assert tuned["result"]["min_shot"] == 0.2
    assert _sha256(two_shot_media) == digest

    queued_solid = _request(
        "POST", f"{server}/jobs/detect_scenes", {"source": str(source_media)}
    )[1]
    solid = _wait(server, queued_solid["id"])
    assert solid["status"] == "done", solid["error"]
    assert solid["result"]["cuts"] == []


def test_get_frame_rejects_a_time_past_the_end(server: str, source_media: Path) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/get_frame",
        {"source": str(source_media), "time": 30},
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "failed"
    assert job["progress"] < 1
    assert "past duration" in job["error"]
    assert _sha256(source_media) == digest


def test_bad_requests_never_start(server: str, tmp_path: Path) -> None:
    missing, missing_body = _request(
        "POST",
        f"{server}/jobs/render_preview",
        {"source": str(tmp_path / "missing.mp4")},
    )
    assert missing == 400
    assert "not a file" in missing_body["error"]
    needs_time, needs_time_body = _request(
        "POST",
        f"{server}/jobs/get_frame",
        {"source": str(tmp_path)},
    )
    assert needs_time == 400
    assert "requires time" in needs_time_body["error"]
    no_prompt, no_prompt_body = _request(
        "POST",
        f"{server}/jobs/sam3_mask",
        {"source": "clip.mp4"},
    )
    assert no_prompt == 400
    assert "prompt" in no_prompt_body["error"]
    no_span, no_span_body = _request(
        "POST",
        f"{server}/jobs/sam_audio",
        {"source": "clip.mp4", "prompt_kind": "span"},
    )
    assert no_span == 400
    assert "span" in no_span_body["error"]
    unknown, _unknown_body = _request("POST", f"{server}/jobs/not_a_tool", {"source": "x"})
    assert unknown == 404
    absent, _absent_body = _request("GET", f"{server}/jobs/does-not-exist")
    assert absent == 404


def test_sam3_mask_tracks_a_matte_as_a_separate_file(
    server: str,
    store: _RecordingStore,
    proxy_dir: Path,
    source_media: Path,
    fake_runner: str,
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam3_mask",
        {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
    )
    assert status == 202
    assert queued["tool"] == "sam3_mask"
    assert queued["kind"] == "sam3_mask"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    matte = Path(result["matte"])
    assert result["source"] == str(source_media)
    assert result["prompt_kind"] == "text"
    assert result["width"] == 320
    assert result["height"] == 240
    assert result["cached"] is False
    assert matte.suffix == ".mp4"
    assert matte.is_relative_to(proxy_dir)
    assert matte != source_media
    assert _streams(matte)[0]["codec_type"] == "video"
    assert _sha256(source_media) == digest
    again = _wait(
        server,
        _request(
            "POST",
            f"{server}/jobs/sam3_mask",
            {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
        )[1]["id"],
    )
    assert again["result"]["cached"] is True
    assert again["result"]["matte"] == str(matte)
    assert _sha256(source_media) == digest


def test_sam3_mask_accepts_a_point_prompt(
    server: str, source_media: Path, fake_runner: str
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam3_mask",
        {"source": str(source_media), "prompt_kind": "point", "point": [0.5, 0.4]},
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["result"]["prompt_kind"] == "point"
    assert Path(job["result"]["matte"]).is_file()
    assert _sha256(source_media) == digest


def test_sam3_mask_fails_with_a_clear_error_when_no_runner(
    server: str, source_media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CHAIR_SAM3_RUNNER", raising=False)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam3_mask",
        {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "failed"
    assert "CHAIR_SAM3_RUNNER" in job["error"]


def test_sam_audio_separates_a_stem_as_a_separate_file(
    server: str,
    store: _RecordingStore,
    proxy_dir: Path,
    source_media: Path,
    fake_audio_runner: str,
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam_audio",
        {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
    )
    assert status == 202
    assert queued["tool"] == "sam_audio"
    assert queued["kind"] == "sam_audio"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    stem = Path(result["stem"])
    assert result["source"] == str(source_media)
    assert result["prompt_kind"] == "text"
    assert result["mode"] == "isolate"
    assert result["duration"] == pytest.approx(1.0, abs=0.05)
    assert result["cached"] is False
    assert stem.suffix == ".wav"
    assert stem.is_relative_to(proxy_dir)
    assert stem != source_media
    assert _streams(stem)[0]["codec_type"] == "audio"
    assert _sha256(source_media) == digest
    again = _wait(
        server,
        _request(
            "POST",
            f"{server}/jobs/sam_audio",
            {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
        )[1]["id"],
    )
    assert again["result"]["cached"] is True
    assert again["result"]["stem"] == str(stem)
    assert _sha256(source_media) == digest


def test_sam_audio_accepts_a_span_prompt(
    server: str, source_media: Path, fake_audio_runner: str
) -> None:
    digest = _sha256(source_media)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam_audio",
        {
            "source": str(source_media),
            "prompt_kind": "span",
            "span": [0.2, 0.8],
            "mode": "remove",
        },
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["result"]["prompt_kind"] == "span"
    assert job["result"]["mode"] == "remove"
    assert Path(job["result"]["stem"]).is_file()
    assert _sha256(source_media) == digest


def test_sam_audio_fails_with_a_clear_error_when_no_runner(
    server: str, source_media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CHAIR_SAM_AUDIO_RUNNER", raising=False)
    status, queued = _request(
        "POST",
        f"{server}/jobs/sam_audio",
        {"source": str(source_media), "prompt_kind": "text", "prompt": "the speaker"},
    )
    assert status == 202
    job = _wait(server, queued["id"])
    assert job["status"] == "failed"
    assert "CHAIR_SAM_AUDIO_RUNNER" in job["error"]


def _wait_store(store: JobStore, job_id: str) -> dict:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = store.get(job_id)
        assert job is not None
        if job["status"] in {"done", "failed"}:
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def test_finished_jobs_survive_a_restart(
    store: JobStore, proxy_dir: Path, source_media: Path
) -> None:
    queued = store.submit(
        "get_frame", MediaRequest(source=str(source_media), time=0.25)
    )
    job = _wait_store(store, queued["id"])
    assert job["status"] == "done", job["error"]
    assert (proxy_dir / "jobs.json").is_file()
    restarted = JobStore(proxy_dir)
    assert restarted.get(queued["id"]) == job


def test_restart_reports_the_last_known_state(proxy_dir: Path) -> None:
    def record(job_id: str, status: str) -> dict:
        return {
            "id": job_id,
            "tool": "render_preview",
            "kind": "proxy",
            "status": status,
            "progress": 0.5,
            "result": None,
            "error": None,
        }

    (proxy_dir / "jobs.json").write_text(
        json.dumps(
            {
                "jobs": {
                    "queued": record("queued", "queued"),
                    "running": record("running", "running"),
                    "done": record("done", "done"),
                }
            }
        )
    )
    restarted = JobStore(proxy_dir)
    assert restarted.get("queued")["status"] == "queued"
    assert restarted.get("running")["status"] == "running"
    assert restarted.get("done")["status"] == "done"


def test_corrupt_job_file_starts_empty(proxy_dir: Path) -> None:
    (proxy_dir / "jobs.json").write_text("not json{")
    restarted = JobStore(proxy_dir)
    assert restarted.get("anything") is None


def _click_samples(bpm: float, seconds: float = 4.0) -> array.array[int]:
    rate = music.SAMPLE_RATE
    frames: array.array[int] = array.array("h", [0]) * int(seconds * rate)
    beat = 0.0
    while beat < seconds:
        start = int(beat * rate)
        for i in range(300):
            if start + i < len(frames):
                frames[start + i] = int(16000 * math.exp(-i / 60))
        beat += 60.0 / bpm
    return frames


def _write_click_wav(path: Path, bpm: float) -> Path:
    frames = _click_samples(bpm)
    if sys.byteorder != "little":
        frames.byteswap()
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(music.SAMPLE_RATE)
        wav.writeframes(frames.tobytes())
    return path


def test_click_tracks_measure_their_tempo() -> None:
    for bpm in (90.0, 120.0, 150.0):
        found = music.analyze(_click_samples(bpm), duration=4.0)
        assert found["tempo_bpm"] == pytest.approx(bpm, abs=0.2)
        assert found["tempo_confidence"] == 1.0
        step = 60.0 / bpm
        assert len(found["beats"]) == round(4.0 / step)
        for beat in found["beats"]:
            nearest = round(beat / step) * step
            assert abs(beat - nearest) < 0.01


def test_steady_audio_has_no_tempo() -> None:
    rate = music.SAMPLE_RATE
    sine = array.array(
        "h", (int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate))
    )
    assert music.analyze(sine, duration=1.0) == {
        "tempo_bpm": None,
        "tempo_confidence": 0.0,
        "transients": [],
        "beats": [],
    }
    silence: array.array[int] = array.array("h", [0]) * rate * 2
    assert music.analyze(silence, duration=2.0)["beats"] == []


def test_markers_carry_resolve_fields() -> None:
    markers = music.build_markers(
        beats=[0.5, 1.0],
        transients=[0.25],
        words=[{"word": "hey", "start": 0.1, "end": 0.4}],
        tempo_bpm=120.0,
        fps=25,
    )
    assert [marker["time"] for marker in markers] == [0.1, 0.25, 0.5, 1.0]
    assert [marker["kind"] for marker in markers] == ["word", "transient", "beat", "beat"]
    assert [marker["color"] for marker in markers] == ["Green", "Yellow", "Blue", "Blue"]
    assert [marker["frame"] for marker in markers] == [2, 6, 12, 25]
    assert markers[0]["name"] == "hey"
    assert markers[2]["name"] == "Beat 1"
    assert markers[2]["note"] == "120.0 BPM"
    assert "frame" not in music.build_markers(
        beats=[0.5], transients=[], words=[], tempo_bpm=None, fps=None
    )[0]


def test_music_request_validates_words_and_fps() -> None:
    with pytest.raises(ValidationError, match="end must be"):
        MusicRequest.model_validate(
            {"source": "song.wav", "words": [{"word": "hey", "start": 0.5, "end": 0.2}]}
        )
    with pytest.raises(ValidationError, match="fps must be"):
        MusicRequest.model_validate({"source": "song.wav", "fps": 0})
    request = MusicRequest.model_validate({"source": "song.wav"})
    assert request.fps is None
    assert request.words == []


def test_analyze_music_caches_markers_per_asset(
    server: str,
    store: _RecordingStore,
    proxy_dir: Path,
    tmp_path: Path,
) -> None:
    clicks = _write_click_wav(tmp_path / "clicks.wav", 120.0)
    digest = _sha256(clicks)
    status, queued = _request(
        "POST", f"{server}/jobs/analyze_music", {"source": str(clicks), "fps": 25}
    )
    assert status == 202
    assert queued["tool"] == "analyze_music"
    assert queued["kind"] == "analyze_music"
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    assert job["progress"] == 1.0
    assert any(0 < seen < 1 for seen in store.seen)
    result = job["result"]
    assert result["tempo_bpm"] == pytest.approx(120.0, abs=0.5)
    assert len(result["beats"]) == 8
    assert result["cached"] is False
    markers_file = Path(result["markers_file"])
    assert markers_file.is_relative_to(proxy_dir)
    assert markers_file.name.startswith("music-")
    stored = json.loads(markers_file.read_text(encoding="utf-8"))
    assert stored["markers"] == result["markers"]
    assert stored["tempo_bpm"] == result["tempo_bpm"]
    assert {marker["kind"] for marker in result["markers"]} <= {"beat", "transient", "word"}
    assert all(marker["frame"] == round(marker["time"] * 25) for marker in result["markers"])
    assert _sha256(clicks) == digest
    again = _wait(
        server,
        _request(
            "POST", f"{server}/jobs/analyze_music", {"source": str(clicks), "fps": 25}
        )[1]["id"],
    )
    assert again["result"]["cached"] is True
    assert again["result"]["markers_file"] == str(markers_file)
    assert again["result"]["markers"] == result["markers"]
    assert _sha256(clicks) == digest


def test_analyze_music_words_become_markers(server: str, tmp_path: Path) -> None:
    clicks = _write_click_wav(tmp_path / "clicks.wav", 120.0)
    words = [
        {"word": "hello", "start": 0.1, "end": 0.4},
        {"word": "world", "start": 0.5, "end": 0.9},
    ]
    _, queued = _request(
        "POST", f"{server}/jobs/analyze_music", {"source": str(clicks), "words": words}
    )
    job = _wait(server, queued["id"])
    assert job["status"] == "done", job["error"]
    word_markers = [m for m in job["result"]["markers"] if m["kind"] == "word"]
    assert [(m["name"], m["time"]) for m in word_markers] == [("hello", 0.1), ("world", 0.5)]
    assert all(m["color"] == "Green" for m in word_markers)


def test_analyze_music_rejects_bad_words(server: str, tmp_path: Path) -> None:
    clicks = _write_click_wav(tmp_path / "clicks.wav", 120.0)
    bad_end, bad_end_body = _request(
        "POST",
        f"{server}/jobs/analyze_music",
        {"source": str(clicks), "words": [{"word": "hey", "start": 0.5, "end": 0.2}]},
    )
    assert bad_end == 400
    assert "end must be" in bad_end_body["error"]
    bad_fps, bad_fps_body = _request(
        "POST", f"{server}/jobs/analyze_music", {"source": str(clicks), "fps": -1}
    )
    assert bad_fps == 400
    assert "fps must be" in bad_fps_body["error"]


def test_health_is_readable_from_the_desktop_origin(server: str) -> None:
    from urllib.request import urlopen

    with urlopen(f"{server}/health") as response:
        assert response.status == 200
        assert response.headers["access-control-allow-origin"] == "*"
