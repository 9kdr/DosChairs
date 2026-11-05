"""Live dispatch: run the finding tools instead of taking hand-fed spans.

An edit job with only a brief plus media reference resolves its spans
from live tool runs: silence spans from the sidecar's measure_audio,
filler spans from the transcription adapter's word timings. The preview
comes from the sidecar's render_preview. Read-only against the source;
findings flow into the loop's gated proposal like canned spans do.
"""

import json
import math
import os
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote, urlsplit

import httpx

from chair_agent.executor import Span, SpanKind
from chair_agent.shots import DEFAULT_SIDECAR_URL
from chair_agent.transcribe import TranscriptionAdapter

_TIMEOUT_SECONDS = 120.0

#: Single-word hesitations the filler intent cuts. Phrases stay out of v1.
FILLER_WORDS = frozenset({"ah", "eh", "erm", "hmm", "mm", "uh", "um"})


class UnexpectedDispatch(Exception):
    pass


class SilenceMeasurer(Protocol):
    def measure_silence(self, media_url: str) -> list[tuple[float, float]]:
        """Silence spans in seconds for one media URL. Reads only."""
        ...


class PreviewRenderer(Protocol):
    def render_preview(self, media_url: str) -> str:
        """Preview URL for one media URL. Renders low-res only."""
        ...


class SidecarTools:
    """measure_audio and render_preview over HTTP: submit, poll, parse."""

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.Client | None = None,
        poll_interval: float = 0.1,
        max_polls: int = 1200,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client if client is not None else httpx.Client(timeout=_TIMEOUT_SECONDS)
        self._poll_interval = poll_interval
        self._max_polls = max_polls

    def measure_silence(self, media_url: str) -> list[tuple[float, float]]:
        result = self._run("measure_audio", {"source": media_url})
        raw = result.get("silence")
        if not isinstance(raw, list):
            raise UnexpectedDispatch("measure_audio finished without silence spans")
        spans: list[tuple[float, float]] = []
        for item in raw:
            if not isinstance(item, dict):
                raise UnexpectedDispatch("measure_audio finished with a bad silence span")
            start, end = item.get("start"), item.get("end")
            if (
                not isinstance(start, (int, float))
                or not isinstance(end, (int, float))
                or not math.isfinite(start)
                or not math.isfinite(end)
                or end < start
            ):
                raise UnexpectedDispatch("measure_audio finished with a bad silence span")
            spans.append((float(start), float(end)))
        return spans

    def render_preview(self, media_url: str) -> str:
        result = self._run("render_preview", {"source": media_url})
        proxy = result.get("proxy")
        if not isinstance(proxy, str) or not proxy:
            raise UnexpectedDispatch("render_preview finished without a proxy path")
        path = Path(proxy)
        if not path.is_absolute():
            raise UnexpectedDispatch("render_preview finished with a relative proxy path")
        return path.as_uri()

    def _run(self, tool: str, body: dict[str, Any]) -> dict[str, Any]:
        job_id = self._submit(tool, body)
        for _ in range(self._max_polls):
            job = self._get(tool, job_id)
            status = job.get("status")
            if status == "done":
                result = job.get("result")
                if not isinstance(result, dict):
                    raise UnexpectedDispatch(f"{tool} finished without a result")
                return result
            if status == "failed":
                raise UnexpectedDispatch(f"{tool} failed: {job.get('error')}")
            if status not in ("queued", "running"):
                raise UnexpectedDispatch(f"{tool} has unknown status: {status!r}")
            time.sleep(self._poll_interval)
        raise UnexpectedDispatch(f"{tool} timed out waiting for the sidecar")

    def _submit(self, tool: str, body: dict[str, Any]) -> str:
        payload = dict(body)
        if "source" in payload and isinstance(payload["source"], str):
            payload["source"] = _normalize_source(payload["source"])
        response = self._client.post(f"{self.base_url}/jobs/{tool}", json=payload)
        self._raise_for_status(tool, response)
        job_id = response.json().get("id")
        if not isinstance(job_id, str) or not job_id:
            raise UnexpectedDispatch(f"{tool} returned no job id")
        return job_id

    def _get(self, tool: str, job_id: str) -> dict[str, Any]:
        response = self._client.get(f"{self.base_url}/jobs/{job_id}")
        self._raise_for_status(tool, response)
        payload = response.json()
        if not isinstance(payload, dict):
            raise UnexpectedDispatch(f"{tool} returned a bad job body")
        return payload

    def _raise_for_status(self, tool: str, response: httpx.Response) -> None:
        if response.is_error:
            try:
                payload = response.json()
                if isinstance(payload, dict) and "error" in payload:
                    raise UnexpectedDispatch(f"{tool} failed: {payload['error']}")
            except (json.JSONDecodeError, ValueError):
                pass
            response.raise_for_status()


def _normalize_source(source: str) -> str:
    if source.startswith("file://"):
        return unquote(urlsplit(source).path)
    return source


def build_sidecar_tools(env: Mapping[str, str] | None = None) -> SidecarTools:
    source: Mapping[str, str] = os.environ if env is None else env
    base_url = source.get("CHAIR_SIDECAR_URL", "").strip() or DEFAULT_SIDECAR_URL
    return SidecarTools(base_url)


def dispatch_spans(
    intents: Sequence[str],
    media_url: str,
    *,
    silence: SilenceMeasurer,
    transcriber: TranscriptionAdapter,
    rate: float,
) -> list[Span]:
    """Run the finding tools the intents name; return their spans in frames.

    A failing transcriber skips the filler pass instead of failing the
    job; use dispatch_spans_with_notes when the note matters.
    """
    spans, _ = dispatch_spans_with_notes(
        intents, media_url, silence=silence, transcriber=transcriber, rate=rate
    )
    return spans


def dispatch_spans_with_notes(
    intents: Sequence[str],
    media_url: str,
    *,
    silence: SilenceMeasurer,
    transcriber: TranscriptionAdapter,
    rate: float,
) -> tuple[list[Span], list[str]]:
    """Run the finding tools; return spans in frames plus plain notes.

    A failing transcriber is non-fatal: the filler spans are skipped,
    the silence spans are kept, and a plain note says what happened.
    """
    if not media_url.strip():
        raise ValueError("live dispatch needs a non-empty media URL")
    if not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError("live dispatch needs a rate above 0")
    spans: list[Span] = []
    notes: list[str] = []
    if "silence" in intents:
        spans.extend(
            _seconds_span(start, end, float(rate), "silence")
            for start, end in silence.measure_silence(media_url)
        )
    if "filler" in intents:
        try:
            transcript = transcriber.transcribe(media_url)
        except Exception as error:
            notes.append(f"Filler words skipped: transcription failed ({_short(error)})")
        else:
            spans.extend(
                _seconds_span(word.start, word.end, float(rate), "filler")
                for word in transcript.words
                if _clean(word.word) in FILLER_WORDS
            )
    return spans, notes


def _short(error: Exception) -> str:
    """First line of an error, capped: long HTTP status text stays readable."""
    lines = str(error).strip().splitlines()
    first = lines[0].strip()[:180] if lines and lines[0].strip() else type(error).__name__
    return first


def _clean(word: str) -> str:
    return word.strip().lower().strip(".,!?;:'\"()")


def _seconds_span(start_s: float, end_s: float, rate: float, kind: SpanKind) -> Span:
    start_frames = max(0, round(start_s * rate))
    end_frames = max(start_frames + 1, round(end_s * rate))
    return Span(start_frames=start_frames, frames=end_frames - start_frames, kind=kind)
