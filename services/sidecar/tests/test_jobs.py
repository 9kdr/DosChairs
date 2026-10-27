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
    active_spans,
    default_proxy_dir,
    parse_ebur128,
    parse_progress,
    parse_silence,
)


def test_job_kinds() -> None:
    assert JobKind.SAM3_MASK.value == "sam3_mask"


def test_progress_uses_out_time_us() -> None:
    assert parse_progress("out_time_us=500000\n", 1.0) == 0.5
    assert parse_progress("out_time_ms=500000\n", 1.0) is None
    assert parse_progress("out_time_us=2000000\n", 1.0) == 0.99


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
    unknown, _unknown_body = _request("POST", f"{server}/jobs/sam3_mask", {"source": "x"})
    assert unknown == 404
    absent, _absent_body = _request("GET", f"{server}/jobs/does-not-exist")
    assert absent == 404
