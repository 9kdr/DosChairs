import json
from collections.abc import Callable

import httpx
import pytest
from chair_agent.shots import (
    Shot,
    SidecarFrames,
    UnexpectedShotFrame,
    build_shot_index,
    build_sidecar_frames,
    describe_shot,
    render_shot_context,
    shot_ranges,
)
from pydantic import ValidationError

HandlerFn = Callable[[httpx.Request], httpx.Response]


def _frames(handler: HandlerFn, *, max_polls: int = 300) -> SidecarFrames:
    return SidecarFrames(
        "http://sidecar.test",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        poll_interval=0,
        max_polls=max_polls,
    )


def test_shot_ranges_split_at_cuts() -> None:
    assert shot_ranges([4.0, 9.5], 12.0) == [(0.0, 4.0), (4.0, 9.5), (9.5, 12.0)]


def test_shot_ranges_without_cuts_is_one_shot() -> None:
    assert shot_ranges([], 12.0) == [(0.0, 12.0)]


def test_shot_ranges_rejects_bad_bounds() -> None:
    with pytest.raises(ValueError):
        shot_ranges([1.0], 0.0)
    with pytest.raises(ValueError):
        shot_ranges([0.0], 12.0)
    with pytest.raises(ValueError):
        shot_ranges([12.0], 12.0)
    with pytest.raises(ValueError):
        shot_ranges([9.0, 4.0], 12.0)
    with pytest.raises(ValueError):
        shot_ranges([4.0, 4.0], 12.0)
    with pytest.raises(ValueError):
        shot_ranges([float("nan")], 12.0)


def test_shot_rejects_bad_spans_and_captions() -> None:
    good = {"index": 1, "start": 0.0, "end": 4.0, "thumbnail": "/t/1.jpg", "caption": "one"}
    Shot(**good)
    for field, value in [("index", 0), ("start", -1.0), ("end", 0.0), ("thumbnail", "  ")]:
        with pytest.raises(ValidationError):
            Shot(**{**good, field: value})
    with pytest.raises(ValidationError):
        Shot(**{**good, "caption": "two\nlines"})
    with pytest.raises(ValidationError):
        Shot(**{**good, "caption": "  "})


def test_build_shot_index_thumbnails_each_midpoint() -> None:
    seen: list[tuple[str, float]] = []

    class MemoryFrames:
        def fetch(self, source: str, time_s: float) -> str:
            seen.append((source, time_s))
            return f"/thumbs/{time_s:.1f}.jpg"

    shots = build_shot_index(
        "/media/clip.mp4",
        [4.0],
        10.0,
        MemoryFrames(),
        captioner=lambda *, index, start, end, thumbnail: f"cap {index}",
    )
    assert seen == [("/media/clip.mp4", 2.0), ("/media/clip.mp4", 7.0)]
    assert [shot.caption for shot in shots] == ["cap 1", "cap 2"]
    assert [(shot.start, shot.end) for shot in shots] == [(0.0, 4.0), (4.0, 10.0)]
    assert [shot.thumbnail for shot in shots] == ["/thumbs/2.0.jpg", "/thumbs/7.0.jpg"]
    with pytest.raises(ValueError):
        build_shot_index("  ", [], 10.0, MemoryFrames())


def test_default_caption_is_a_factual_one_liner() -> None:
    caption = describe_shot(index=2, start=4.0, end=9.5, thumbnail="/t/2.jpg")
    assert "\n" not in caption
    assert "2" in caption and "4.0" in caption and "9.5" in caption


def test_sidecar_frames_submit_and_poll_for_the_path() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.method == "POST":
            assert request.url.path == "/jobs/get_frame"
            assert json.loads(request.content) == {"source": "/media/clip.mp4", "time": 2.0}
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        polls = len([call for call in calls if call.startswith("GET")])
        if polls < 2:
            return httpx.Response(200, json={"id": "job1", "status": "running"})
        return httpx.Response(
            200,
            json={"id": "job1", "status": "done", "result": {"frame": "/proxy/frame.jpg"}},
        )

    assert _frames(handler).fetch("/media/clip.mp4", 2.0) == "/proxy/frame.jpg"
    assert calls[0] == "POST /jobs/get_frame"
    assert calls[-1] == "GET /jobs/job1"


def test_sidecar_frames_failure_and_timeout() -> None:
    def failed(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(200, json={"id": "job1", "status": "failed", "error": "no video"})

    with pytest.raises(UnexpectedShotFrame, match="no video"):
        _frames(failed).fetch("/media/clip.mp4", 2.0)

    def stuck(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(200, json={"id": "job1", "status": "running"})

    with pytest.raises(UnexpectedShotFrame, match="timed out"):
        _frames(stuck, max_polls=2).fetch("/media/clip.mp4", 2.0)

    def weird(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(200, json={"id": "job1", "status": "done", "result": {}})

    with pytest.raises(UnexpectedShotFrame, match="without a frame path"):
        _frames(weird).fetch("/media/clip.mp4", 2.0)


def test_build_sidecar_frames_reads_the_env() -> None:
    assert build_sidecar_frames({}).base_url == "http://127.0.0.1:8788"
    assert (
        build_sidecar_frames({"CHAIR_SIDECAR_URL": "http://sidecar:9999/"}).base_url
        == "http://sidecar:9999"
    )


def test_render_shot_context_is_one_line_per_shot() -> None:
    shots = [
        Shot(index=1, start=0.0, end=4.0, thumbnail="/t/1.jpg", caption="wide room"),
        Shot(index=2, start=4.0, end=10.0, thumbnail="/t/2.jpg", caption="close face"),
    ]
    assert render_shot_context(shots) == (
        "Shots (2):\n"
        "- shot 1 [0.00s-4.00s] thumb=/t/1.jpg: wide room\n"
        "- shot 2 [4.00s-10.00s] thumb=/t/2.jpg: close face"
    )
    assert render_shot_context([]) == "Shots (0):\n- none indexed"
