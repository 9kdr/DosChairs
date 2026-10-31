"""Transcription behind the model client, plus a subtitle-track changeset.

A talking-head file goes to the Meta realtime ASR endpoint and comes back
with word timestamps. build_cues groups words into subtitle cues,
subtitle_track_op wraps them in a pending add_track item, and
build_transcript_index keeps a compact text index for later prompts.
The source audio is only read, never written.
"""

import os
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from chair_agent.client import HttpxTransport, Transport, load_settings
from chair_agent.edit_ops import ChangesetItem
from chair_agent.jobs import HandlerResult, Job

DEFAULT_ASR_MODEL = "meta-asr-realtime-1"


class Word(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word: str
    start: float
    end: float


class Cue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: float
    end: float
    text: str


class Transcript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    words: list[Word] = []
    language: str | None = None


class UnexpectedTranscript(Exception):
    pass


class TranscriptionAdapter(Protocol):
    def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript: ...


class HttpTranscriptionAdapter:
    def __init__(self, transport: Transport, *, model: str, api_key: str | None) -> None:
        self.transport = transport
        self._model = model
        self._api_key = api_key

    def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
        body: dict[str, Any] = {
            "model": self._model,
            "url": audio_url,
            "response_format": "verbose_json",
            "timestamp_granularities": ["word"],
        }
        if language:
            body["language"] = language
        payload = self.transport.post_json("/audio/transcriptions", body, self._api_key)
        return _transcript(payload, language=language)


def build_transcription_adapter(env: Mapping[str, str] | None = None) -> HttpTranscriptionAdapter:
    settings = load_settings(env)
    source: Mapping[str, str] = os.environ if env is None else env
    model = (source.get("CHAIR_ASR_MODEL", "") or "").strip() or DEFAULT_ASR_MODEL
    return HttpTranscriptionAdapter(
        HttpxTransport(settings.base_url),
        model=model,
        api_key=settings.api_key,
    )


def _transcript(payload: dict[str, Any], *, language: str | None) -> Transcript:
    text = payload.get("text")
    raw_words = payload.get("words")
    if not isinstance(text, str) or not isinstance(raw_words, list):
        raise UnexpectedTranscript
    words: list[Word] = []
    for raw in raw_words:
        if not isinstance(raw, dict):
            raise UnexpectedTranscript
        word = raw.get("word")
        start = raw.get("start")
        end = raw.get("end")
        if (
            not isinstance(word, str)
            or not word
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or start < 0
            or end < start
        ):
            raise UnexpectedTranscript
        words.append(Word(word=word, start=float(start), end=float(end)))
    return Transcript(text=text, words=words, language=language)


def build_cues(words: Sequence[Word], *, max_chars: int = 84, max_gap: float = 1.0) -> list[Cue]:
    """Group words into subtitle cues on length and silence gaps."""
    cues: list[Cue] = []
    current: list[Word] = []

    def flush() -> None:
        if current:
            cues.append(
                Cue(
                    start=current[0].start,
                    end=current[-1].end,
                    text=" ".join(word.word for word in current),
                )
            )
            current.clear()

    for word in words:
        text = " ".join([*(w.word for w in current), word.word])
        gap = word.start - current[-1].end if current else 0.0
        if current and (len(text) > max_chars or gap > max_gap):
            flush()
        current.append(word)
    flush()
    return cues


def build_transcript_index(cues: Sequence[Cue], *, budget_chars: int = 2000) -> str:
    """Compact timed lines for later prompts; oldest cues first, cut to budget."""
    lines = [f"[{cue.start:.1f}-{cue.end:.1f}] {cue.text}" for cue in cues]
    kept: list[str] = []
    used = 0
    for line in lines:
        cost = len(line) + (1 if kept else 0)
        if used + cost > budget_chars:
            break
        kept.append(line)
        used += cost
    index = "\n".join(kept)
    dropped = len(lines) - len(kept)
    if dropped:
        index += f"\n…({dropped} more cues)"
    return index


def subtitle_track_op(
    id: str,
    rationale: str,
    cues: Sequence[Cue],
    *,
    rate: float = 30.0,
    track_id: str = "subtitles_1",
    track_name: str = "Subtitles",
) -> ChangesetItem:
    """Pending add_track item carrying the subtitle track. Audio untouched."""
    if rate <= 0:
        raise ValueError("subtitle track needs a rate above 0")

    def moment(seconds: float) -> dict[str, float]:
        return {"value": seconds * rate, "rate": rate}

    clips = [
        {
            "id": f"{track_id}_cue_{index}",
            "name": cue.text,
            "sourceRange": {
                "start": moment(cue.start),
                "duration": moment(cue.end - cue.start),
            },
            "timelineRange": {
                "start": moment(cue.start),
                "duration": moment(cue.end - cue.start),
            },
        }
        for index, cue in enumerate(cues)
    ]
    return ChangesetItem(
        id=id,
        op="add_track",
        rationale=rationale,
        patch={"track": {"id": track_id, "kind": "subtitle", "name": track_name, "clips": clips}},
    )


def handle_transcribe(job: Job, adapter: TranscriptionAdapter | None = None) -> HandlerResult:
    """Transcribe job task: word timestamps plus a pending subtitle track."""
    media_url = job.input.get("media_url")
    if not isinstance(media_url, str) or not media_url.strip():
        raise ValueError("transcribe needs job input media_url")
    rate = job.input.get("rate", 30.0)
    if not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError("transcribe needs job input rate above 0")
    language = job.input.get("language")
    if language is not None and not isinstance(language, str):
        raise ValueError("transcribe needs job input language as a string")
    used = adapter if adapter is not None else build_transcription_adapter()
    transcript = used.transcribe(media_url, language=language)
    cues = build_cues(transcript.words)
    item = subtitle_track_op(
        f"{job.request_id}-subtitles",
        f"Subtitle track from transcript ({len(transcript.words)} words, "
        f"{len(cues)} cues). Source audio unchanged.",
        cues,
        rate=float(rate),
    )
    return HandlerResult(ops=[item.model_dump(by_alias=True, exclude_none=True, mode="json")])
