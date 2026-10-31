import json
from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest
from chair_agent.client import HttpxTransport
from chair_agent.edit_ops import build_changeset, validate_changeset
from chair_agent.jobs import Job
from chair_agent.transcribe import (
    Cue,
    HttpTranscriptionAdapter,
    Transcript,
    TranscriptionAdapter,
    UnexpectedTranscript,
    Word,
    build_cues,
    build_transcript_index,
    build_transcription_adapter,
    handle_transcribe,
    subtitle_track_op,
)

HandlerFn = Callable[[httpx.Request], httpx.Response]


def _adapter(handler: HandlerFn, *, api_key: str | None = "asr-ok") -> HttpTranscriptionAdapter:
    return HttpTranscriptionAdapter(
        HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
        model="meta-asr-realtime-1",
        api_key=api_key,
    )


def _payload() -> dict:
    return {
        "text": "hello world",
        "words": [
            {"word": "hello", "start": 0.5, "end": 0.9},
            {"word": "world", "start": 1.0, "end": 1.4},
        ],
    }


def _job(**input: object) -> Job:
    return Job(
        request_id="req_1",
        task="transcribe",
        input=dict(input),
        created_at=datetime.now(UTC),
    )


def test_http_adapter_posts_asr_endpoint_and_reads_word_timestamps() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audio/transcriptions"
        assert json.loads(request.content) == {
            "model": "meta-asr-realtime-1",
            "url": "https://example.test/talking-head.mp4",
            "response_format": "verbose_json",
            "timestamp_granularities": ["word"],
        }
        assert request.headers["authorization"] == "Bearer asr-ok"
        return httpx.Response(200, json=_payload())

    transcript = _adapter(handler).transcribe("https://example.test/talking-head.mp4")
    assert transcript.text == "hello world"
    assert transcript.words == [
        Word(word="hello", start=0.5, end=0.9),
        Word(word="world", start=1.0, end=1.4),
    ]


def test_unexpected_transcript_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "hello", "words": [{"word": "hello"}]})

    with pytest.raises(UnexpectedTranscript):
        _adapter(handler).transcribe("https://example.test/talking-head.mp4")


def test_transcription_adapter_can_be_swapped() -> None:
    class MemoryAdapter:
        def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
            return Transcript(
                text="hello world",
                words=[
                    Word(word="hello", start=0.5, end=0.9),
                    Word(word="world", start=1.0, end=1.4),
                ],
                language=language,
            )

    def run(adapter: TranscriptionAdapter) -> Transcript:
        return adapter.transcribe("mem://talking-head")

    assert run(MemoryAdapter()).words[1].word == "world"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_payload())

    assert run(_adapter(handler)).text == "hello world"


def test_build_adapter_uses_the_model_api_env() -> None:
    adapter = build_transcription_adapter(
        {
            "META_API_BASE_URL": "https://example.test/v1",
            "META_API_KEY": "test-key",
            "CHAIR_ASR_MODEL": "meta-asr-realtime-1",
        }
    )
    assert isinstance(adapter, HttpTranscriptionAdapter)
    assert isinstance(adapter.transport, HttpxTransport)
    assert adapter.transport.base_url == "https://example.test/v1"


def test_cues_break_on_silence_and_length() -> None:
    words = [
        Word(word="hello", start=0.5, end=0.9),
        Word(word="world", start=3.0, end=3.4),
    ]
    cues = build_cues(words)
    assert [(cue.start, cue.end, cue.text) for cue in cues] == [
        (0.5, 0.9, "hello"),
        (3.0, 3.4, "world"),
    ]
    long = build_cues(words, max_chars=5)
    assert [cue.text for cue in long] == ["hello", "world"]
    joined = build_cues(words, max_chars=80, max_gap=5.0)
    assert [cue.text for cue in joined] == ["hello world"]


def test_transcript_index_stays_inside_its_budget() -> None:
    cues = [Cue(start=float(i), end=float(i) + 0.5, text=f"line {i}") for i in range(20)]
    index = build_transcript_index(cues, budget_chars=60)
    assert index.startswith("[0.0-0.5] line 0")
    assert "more cues)" in index
    body, _, _ = index.rpartition("\n…(")
    assert len(body) <= 60
    full = build_transcript_index(cues, budget_chars=10_000)
    assert "more cues)" not in full
    assert full.count("\n") == 19


def test_subtitle_track_op_validates_as_pending_changeset() -> None:
    cues = build_cues(
        [
            Word(word="hello", start=0.5, end=0.9),
            Word(word="world", start=1.0, end=1.4),
        ]
    )
    item = subtitle_track_op("item_subs", "Subtitles for the talking head.", cues, rate=30.0)
    assert item.op == "add_track"
    assert item.status == "pending"
    changeset = build_changeset("cs_1", "rev_0", [item], summary="Add subtitles")
    dumped = changeset.model_dump(by_alias=True, exclude_none=True, mode="json")
    validated = validate_changeset(dumped)
    track = validated.items[0].patch["track"]
    assert track["kind"] == "subtitle"
    assert track["clips"][0]["name"] == "hello world"
    assert track["clips"][0]["timelineRange"]["start"] == {"value": 15.0, "rate": 30.0}
    with pytest.raises(ValueError):
        subtitle_track_op("item_subs", "Bad rate.", cues, rate=0)


def test_handle_transcribe_returns_word_timestamps_and_a_pending_track() -> None:
    class MemoryAdapter:
        def __init__(self) -> None:
            self.seen: list[str] = []

        def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
            self.seen.append(audio_url)
            return Transcript(
                text="hello world",
                words=[
                    Word(word="hello", start=0.5, end=0.9),
                    Word(word="world", start=1.0, end=1.4),
                ],
            )

    adapter = MemoryAdapter()
    job = _job(media_url="https://example.test/talking-head.mp4")
    result = handle_transcribe(job, adapter)
    assert adapter.seen == ["https://example.test/talking-head.mp4"]
    assert len(result.ops) == 1
    op = result.ops[0]
    assert op["op"] == "add_track"
    assert op["status"] == "pending"
    assert op["patch"]["track"]["kind"] == "subtitle"
    assert "Source audio unchanged" in op["rationale"]
    validated = validate_changeset(
        {"schemaVersion": "0.1.0", "id": "cs_1", "baseRevision": "rev_0", "items": [op]}
    )
    assert validated.items[0].id == "req_1-subtitles"


def test_handle_transcribe_rejects_bad_input() -> None:
    class MemoryAdapter:
        def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
            raise AssertionError("must not call the endpoint")

    with pytest.raises(ValueError):
        handle_transcribe(_job(), MemoryAdapter())
    with pytest.raises(ValueError):
        handle_transcribe(_job(media_url="https://example.test/a.mp4", rate=0), MemoryAdapter())
