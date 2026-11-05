import json
from collections.abc import Callable

import httpx
import pytest
from chair_agent.dispatch import (
    SidecarTools,
    UnexpectedDispatch,
    build_sidecar_tools,
    dispatch_spans,
    dispatch_spans_with_notes,
)
from chair_agent.transcribe import Transcript, Word

HandlerFn = Callable[[httpx.Request], httpx.Response]


def _tools(handler: HandlerFn, *, max_polls: int = 300) -> SidecarTools:
    return SidecarTools(
        "http://sidecar.test",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        poll_interval=0,
        max_polls=max_polls,
    )


class _Silence:
    def __init__(self, spans: list[tuple[float, float]]) -> None:
        self.spans = spans
        self.seen: list[str] = []

    def measure_silence(self, media_url: str) -> list[tuple[float, float]]:
        self.seen.append(media_url)
        return self.spans


class _Transcriber:
    def __init__(self, words: list[Word]) -> None:
        self.words = words
        self.seen: list[str] = []

    def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
        self.seen.append(audio_url)
        return Transcript(text=" ".join(word.word for word in self.words), words=self.words)


def test_dispatch_runs_only_the_intents_tools() -> None:
    silence = _Silence([(4.0, 5.0)])
    transcript = _Transcriber([Word(word="um", start=30.0, end=30.6)])
    spans = dispatch_spans(
        ["silence", "filler"],
        "file:///proxy.mp4",
        silence=silence,
        transcriber=transcript,
        rate=30.0,
    )
    assert [(span.start_frames, span.frames, span.kind) for span in spans] == [
        (120, 30, "silence"),
        (900, 18, "filler"),
    ]
    assert silence.seen == ["file:///proxy.mp4"]
    assert transcript.seen == ["file:///proxy.mp4"]

    quiet = _Transcriber([Word(word="um", start=1.0, end=1.5)])
    dispatch_spans(["silence"], "file:///proxy.mp4", silence=silence,
                   transcriber=quiet, rate=30.0)
    assert quiet.seen == []


def test_dispatch_matches_fillers_case_insensitively() -> None:
    words = [
        Word(word="Well", start=1.0, end=1.4),
        Word(word="Um,", start=2.0, end=2.3),
        Word(word="hello", start=3.0, end=3.5),
        Word(word="UH", start=4.0, end=4.2),
    ]
    spans = dispatch_spans(
        ["filler"], "file:///proxy.mp4", silence=_Silence([]),
        transcriber=_Transcriber(words), rate=30.0,
    )
    assert [(span.start_frames, span.kind) for span in spans] == [(60, "filler"), (120, "filler")]


def test_dispatch_keeps_sub_frame_spans_valid() -> None:
    spans = dispatch_spans(
        ["silence"], "file:///proxy.mp4", silence=_Silence([(4.0, 4.005)]),
        transcriber=_Transcriber([]), rate=30.0,
    )
    assert [(span.start_frames, span.frames) for span in spans] == [(120, 1)]


def test_dispatch_validates_media_and_rate() -> None:
    with pytest.raises(ValueError):
        dispatch_spans(["silence"], "  ", silence=_Silence([]),
                       transcriber=_Transcriber([]), rate=30.0)
    with pytest.raises(ValueError):
        dispatch_spans(["silence"], "file:///proxy.mp4", silence=_Silence([]),
                       transcriber=_Transcriber([]), rate=0)


def test_sidecar_tools_measure_and_poll() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.method == "POST":
            assert request.url.path == "/jobs/measure_audio"
            assert json.loads(request.content) == {"source": "/proxy.mp4"}
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        polls = len([call for call in calls if call.startswith("GET")])
        if polls < 2:
            return httpx.Response(200, json={"id": "job1", "status": "running"})
        return httpx.Response(
            200,
            json={
                "id": "job1",
                "status": "done",
                "result": {"silence": [{"start": 4.0, "end": 5.0}]},
            },
        )

    assert _tools(handler).measure_silence("file:///proxy.mp4") == [(4.0, 5.0)]
    assert calls[0] == "POST /jobs/measure_audio"
    assert calls[-1] == "GET /jobs/job1"


def test_sidecar_tools_surfaces_sidecar_400_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": "source is not a file: /not/a/file.mp4"},
        )

    with pytest.raises(UnexpectedDispatch, match="source is not a file"):
        _tools(handler).measure_silence("file:///not/a/file.mp4")


def test_sidecar_tools_reject_bad_measure_results() -> None:
    def failed(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(200, json={"id": "job1", "status": "failed", "error": "no audio"})

    with pytest.raises(UnexpectedDispatch, match="no audio"):
        _tools(failed).measure_silence("file:///proxy.mp4")

    def stuck(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(200, json={"id": "job1", "status": "running"})

    with pytest.raises(UnexpectedDispatch, match="timed out"):
        _tools(stuck, max_polls=2).measure_silence("file:///proxy.mp4")

    def weird(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(
            200, json={"id": "job1", "status": "done", "result": {"silence": [{"start": "x"}]}}
        )

    with pytest.raises(UnexpectedDispatch, match="bad silence span"):
        _tools(weird).measure_silence("file:///proxy.mp4")


def test_sidecar_tools_render_returns_a_file_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            assert request.url.path == "/jobs/render_preview"
            assert json.loads(request.content) == {"source": "/proxy.mp4"}
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(
            200,
            json={"id": "job1", "status": "done", "result": {"proxy": "/previews/p1.mp4"}},
        )

    assert _tools(handler).render_preview("file:///proxy.mp4") == "file:///previews/p1.mp4"

    def relative(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        return httpx.Response(
            200, json={"id": "job1", "status": "done", "result": {"proxy": "p1.mp4"}}
        )

    with pytest.raises(UnexpectedDispatch, match="relative proxy path"):
        _tools(relative).render_preview("file:///proxy.mp4")


class _FailingTranscriber:
    def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
        raise RuntimeError("404 Not Found")


def test_dispatch_transcriber_failure_skips_filler_keeps_silence() -> None:
    """A dead transcription endpoint is non-fatal: silence spans stay, plus a note."""
    spans, notes = dispatch_spans_with_notes(
        ["silence", "filler"],
        "file:///proxy.mp4",
        silence=_Silence([(4.0, 5.0)]),
        transcriber=_FailingTranscriber(),
        rate=30.0,
    )
    assert [(span.start_frames, span.frames, span.kind) for span in spans] == [
        (120, 30, "silence")
    ]
    assert notes == ["Filler words skipped: transcription failed (404 Not Found)"]


def test_dispatch_spans_wrapper_survives_transcriber_failure() -> None:
    spans = dispatch_spans(
        ["silence", "filler"],
        "file:///proxy.mp4",
        silence=_Silence([(4.0, 5.0)]),
        transcriber=_FailingTranscriber(),
        rate=30.0,
    )
    assert [(span.start_frames, span.kind) for span in spans] == [(120, "silence")]


def test_build_sidecar_tools_reads_the_env() -> None:
    assert build_sidecar_tools({}).base_url == "http://127.0.0.1:8788"
    assert (
        build_sidecar_tools({"CHAIR_SIDECAR_URL": "http://sidecar:9999/"}).base_url
        == "http://sidecar:9999"
    )
