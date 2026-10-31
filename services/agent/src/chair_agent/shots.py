"""Shot index from scene cuts for agent context.

Cut times become shot spans; each shot carries a thumbnail path fetched from
the sidecar's existing get_frame tool and a one-line caption. The rendered
context block holds paths and captions only, never frame bytes, so it stays
small enough for the planner prompt. Read-only: source media is untouched.
"""

import math
import os
import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

DEFAULT_SIDECAR_URL = "http://127.0.0.1:8788"
_TIMEOUT_SECONDS = 30.0


class Shot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    index: int
    start: float
    end: float
    thumbnail: str
    caption: str

    @field_validator("index")
    @classmethod
    def index_starts_at_one(cls, value: int) -> int:
        if value < 1:
            raise ValueError("shot index starts at 1")
        return value

    @field_validator("thumbnail", "caption")
    @classmethod
    def text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("thumbnail and caption must be non-empty")
        return value

    @field_validator("caption")
    @classmethod
    def caption_is_one_line(cls, value: str) -> str:
        if "\n" in value or "\r" in value:
            raise ValueError("caption must be one line")
        return value

    @model_validator(mode="after")
    def end_after_start(self) -> "Shot":
        if not math.isfinite(self.start) or self.start < 0:
            raise ValueError("shot start must be >= 0")
        if not math.isfinite(self.end) or self.end <= self.start:
            raise ValueError("shot end must be after start")
        return self


def shot_ranges(cuts: Sequence[float], duration: float) -> list[tuple[float, float]]:
    """Split a clip into shot (start, end) spans at interior cut times."""
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be a positive number of seconds")
    for cut in cuts:
        if not isinstance(cut, (int, float)) or not math.isfinite(cut):
            raise ValueError("cut times must be numbers")
        if not 0 < cut < duration:
            raise ValueError("cut times must sit strictly inside the clip")
    ordered = sorted(cuts)
    if list(cuts) != ordered or len(set(ordered)) != len(ordered):
        raise ValueError("cut times must be strictly increasing")
    bounds = [0.0, *ordered, float(duration)]
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


class UnexpectedShotFrame(Exception):
    pass


class FrameFetcher(Protocol):
    def fetch(self, source: str, time_s: float) -> str:
        """Return the thumbnail path for one frame. Never the bytes."""
        ...


class SidecarFrames:
    """Thumbnails via the sidecar's get_frame tool: submit, poll, read the path."""

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.Client | None = None,
        poll_interval: float = 0.1,
        max_polls: int = 300,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client if client is not None else httpx.Client(timeout=_TIMEOUT_SECONDS)
        self._poll_interval = poll_interval
        self._max_polls = max_polls

    def fetch(self, source: str, time_s: float) -> str:
        job_id = self._submit(source, time_s)
        for _ in range(self._max_polls):
            job = self._get(job_id)
            status = job.get("status")
            if status == "done":
                return _frame_path(job)
            if status == "failed":
                raise UnexpectedShotFrame(f"get_frame failed: {job.get('error')}")
            if status not in ("queued", "running"):
                raise UnexpectedShotFrame(f"get_frame has unknown status: {status!r}")
            time.sleep(self._poll_interval)
        raise UnexpectedShotFrame("get_frame timed out waiting for the sidecar")

    def _submit(self, source: str, time_s: float) -> str:
        response = self._client.post(
            f"{self.base_url}/jobs/get_frame", json={"source": source, "time": time_s}
        )
        response.raise_for_status()
        job_id = response.json().get("id")
        if not isinstance(job_id, str) or not job_id:
            raise UnexpectedShotFrame("get_frame returned no job id")
        return job_id

    def _get(self, job_id: str) -> dict[str, Any]:
        response = self._client.get(f"{self.base_url}/jobs/{job_id}")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise UnexpectedShotFrame("get_frame returned a bad job body")
        return payload


def _frame_path(job: dict[str, Any]) -> str:
    result = job.get("result")
    if not isinstance(result, dict):
        raise UnexpectedShotFrame("get_frame finished without a result")
    frame = result.get("frame")
    if not isinstance(frame, str) or not frame:
        raise UnexpectedShotFrame("get_frame finished without a frame path")
    return frame


def build_sidecar_frames(env: Mapping[str, str] | None = None) -> SidecarFrames:
    source: Mapping[str, str] = os.environ if env is None else env
    base_url = source.get("CHAIR_SIDECAR_URL", "").strip() or DEFAULT_SIDECAR_URL
    return SidecarFrames(base_url)


class Captioner(Protocol):
    def __call__(self, *, index: int, start: float, end: float, thumbnail: str) -> str:
        """One line describing the shot. Implementations may read the file."""
        ...


def describe_shot(*, index: int, start: float, end: float, thumbnail: str) -> str:
    """Default caption: a factual one-liner from shot times, never invented content."""
    return f"Shot {index} ({start:.1f}s-{end:.1f}s)"


def build_shot_index(
    source: str,
    cuts: Sequence[float],
    duration: float,
    frames: FrameFetcher,
    *,
    captioner: Captioner = describe_shot,
) -> list[Shot]:
    """Index every shot: cut times, a sidecar thumbnail path, one caption line."""
    if not source.strip():
        raise ValueError("source must be a non-empty path")
    shots: list[Shot] = []
    for position, (start, end) in enumerate(shot_ranges(cuts, duration), start=1):
        thumbnail = frames.fetch(source, (start + end) / 2)
        caption = captioner(index=position, start=start, end=end, thumbnail=thumbnail)
        shots.append(
            Shot(index=position, start=start, end=end, thumbnail=thumbnail, caption=caption)
        )
    return shots


def render_shot_context(shots: Sequence[Shot]) -> str:
    """Compact context block: one line per shot, paths and captions, no bytes."""
    lines = [f"Shots ({len(shots)}):"]
    if not shots:
        lines.append("- none indexed")
        return "\n".join(lines)
    for shot in shots:
        lines.append(
            f"- shot {shot.index} [{shot.start:.2f}s-{shot.end:.2f}s] "
            f"thumb={shot.thumbnail}: {shot.caption}"
        )
    return "\n".join(lines)
