import hashlib
import json
import subprocess
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_sidecar.__main__ import SidecarServer
from chair_sidecar.jobs import (
    JobKind,
    JobStore,
    MediaRequest,
    Sam3Request,
    SamAudioRequest,
    active_spans,
    default_proxy_dir,
    parse_ebur128,
    parse_progress,
    parse_runner_progress,
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
    assert "sam_audio" in body["jobs"]
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
