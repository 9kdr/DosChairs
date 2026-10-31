"""Verifier: accepts or rejects a preview before the UI shows it.

Mechanical checks always run: the changeset is valid and pending-only, a
preview exists, and every cut fits inside the proxy. Passing the beat
sheet or style profile hardens the gate (issue #16): low-res frames and
an audio snippet must back the preview, every beat needs an edit, timed
beats need a frame showing them, transitions stay inside the style
vocabulary, and loudness sits near the style target. Without plan or
style the mechanical verdict stands alone.
"""

import math
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from chair_agent.beats import InvalidStoryPlan, StoryPlan, validate_story_plan
from chair_agent.edit_ops import Changeset, InvalidChangeset, validate_changeset
from chair_agent.shots import FrameFetcher
from chair_agent.style import StyleProfile, parse_style_profile

_LOUDNESS_TOLERANCE_LUFS = 2.0


class Verdict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    accepted: bool
    reasons: list[str]


class FrameEvidence(BaseModel):
    """One low-res frame backing the preview: when, where, and one caption line."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    time_s: float = Field(ge=0)
    path: str = Field(min_length=1)
    caption: str = Field(min_length=1)

    @field_validator("time_s")
    @classmethod
    def time_is_finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("frame time must be finite")
        return value

    @field_validator("caption")
    @classmethod
    def caption_is_one_line(cls, value: str) -> str:
        if "\n" in value or "\r" in value:
            raise ValueError("caption must be one line")
        return value


class AudioEvidence(BaseModel):
    """The audio snippet backing the preview: where, its loudness, its words."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str = Field(min_length=1)
    loudness_lufs: float | None = None
    transcript: str = ""

    @field_validator("loudness_lufs")
    @classmethod
    def loudness_is_finite(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("loudness must be finite")
        return value


class FrameCaptioner(Protocol):
    def __call__(self, *, time_s: float, path: str) -> str:
        """One line describing the frame. Implementations may read the file."""
        ...


def describe_frame(*, time_s: float, path: str) -> str:
    """Default caption: a factual one-liner from the frame time."""
    return f"Frame at {time_s:.1f}s"


def collect_frame_evidence(
    source: str,
    times: Sequence[float],
    fetcher: FrameFetcher,
    *,
    captioner: FrameCaptioner = describe_frame,
) -> list[FrameEvidence]:
    """Fetch one low-res frame per time via the sidecar get_frame pattern."""
    if not source.strip():
        raise ValueError("source must be a non-empty path")
    evidence: list[FrameEvidence] = []
    for time_s in times:
        if not isinstance(time_s, (int, float)) or not math.isfinite(time_s) or time_s < 0:
            raise ValueError("frame times must be numbers >= 0")
        moment = float(time_s)
        path = fetcher.fetch(source, moment)
        evidence.append(
            FrameEvidence(time_s=moment, path=path, caption=captioner(time_s=moment, path=path))
        )
    return evidence


def verify(
    changeset_data: Mapping[str, Any],
    *,
    artifact_urls: Sequence[str],
    total_frames: int,
    plan: StoryPlan | Mapping[str, Any] | None = None,
    style: StyleProfile | Mapping[str, Any] | None = None,
    frames: Sequence[FrameEvidence | Mapping[str, Any]] = (),
    audio: AudioEvidence | Mapping[str, Any] | None = None,
) -> Verdict:
    """Accept or reject a preview. Rejections carry reasons; accepts don't.

    Content checks engage when the beat sheet or style profile is given;
    frames and the audio snippet are ignored without them.
    """
    reasons: list[str] = []
    try:
        changeset = validate_changeset(changeset_data)
    except InvalidChangeset as error:
        return Verdict(accepted=False, reasons=[f"invalid changeset: {error}"])
    if not changeset.items:
        reasons.append("changeset has no items")
    for item in changeset.items:
        if item.status != "pending":
            reasons.append(f"item {item.id} is {item.status}, not pending")
    if not list(artifact_urls):
        reasons.append("no preview rendered")
    ranges: list[tuple[str, int, int]] = []
    for item in changeset.items:
        patch = item.patch or {}
        if item.op == "remove_clip":
            start = patch.get("startFrames", 0)
            frames_count = patch.get("frames", 0)
            if not isinstance(start, int) or not isinstance(frames_count, int):
                reasons.append(f"item {item.id} has a non-integer cut range")
                continue
            if start < 0 or frames_count <= 0 or start + frames_count > total_frames:
                reasons.append(f"item {item.id} cuts outside the proxy")
            else:
                ranges.append((item.id, start, start + frames_count))
    ordered = sorted(ranges, key=lambda entry: entry[1])
    for first, second in zip(ordered, ordered[1:], strict=False):
        if second[1] < first[2]:
            reasons.append(f"items {first[0]} and {second[0]} cut overlapping frames")
    cut_frames = sum(end - start for _, start, end in ranges)
    if ranges and cut_frames >= total_frames:
        reasons.append("cuts remove the whole proxy")
    sheet = _coerce_plan(plan, reasons)
    profile = _coerce_style(style, reasons)
    if sheet is None and profile is None:
        return Verdict(accepted=not reasons, reasons=reasons)
    seen_frames = _coerce_frames(frames, reasons)
    snippet = _coerce_audio(audio, reasons)
    if sheet is not None:
        _check_beats(changeset, sheet, seen_frames, reasons)
    if profile is not None:
        _check_style(changeset, profile, snippet, reasons)
    if not seen_frames:
        reasons.append("no frame evidence for the preview")
    if snippet is None:
        reasons.append("no audio snippet for the preview")
    return Verdict(accepted=not reasons, reasons=reasons)


def _coerce_plan(
    data: StoryPlan | Mapping[str, Any] | None, reasons: list[str]
) -> StoryPlan | None:
    if data is None:
        return None
    if isinstance(data, StoryPlan):
        return data
    if not isinstance(data, Mapping):
        reasons.append("beat sheet must be a story plan or a mapping")
        return None
    try:
        return validate_story_plan(data)
    except InvalidStoryPlan as error:
        reasons.append(f"invalid beat sheet: {error}")
        return None


def _coerce_style(
    data: StyleProfile | Mapping[str, Any] | None, reasons: list[str]
) -> StyleProfile | None:
    if data is None:
        return None
    if isinstance(data, StyleProfile):
        return data
    if not isinstance(data, Mapping):
        reasons.append("style profile must be a profile or a mapping")
        return None
    try:
        return parse_style_profile(data)
    except ValidationError as error:
        reasons.append(f"invalid style profile: {error}")
        return None


def _coerce_frames(
    items: Sequence[FrameEvidence | Mapping[str, Any]], reasons: list[str]
) -> list[FrameEvidence]:
    evidence: list[FrameEvidence] = []
    for item in items:
        if isinstance(item, FrameEvidence):
            evidence.append(item)
            continue
        if not isinstance(item, Mapping):
            reasons.append("frame evidence must be evidence or a mapping")
            continue
        try:
            evidence.append(FrameEvidence.model_validate(item))
        except ValidationError as error:
            reasons.append(f"invalid frame evidence: {error}")
    return evidence


def _coerce_audio(
    data: AudioEvidence | Mapping[str, Any] | None, reasons: list[str]
) -> AudioEvidence | None:
    if data is None:
        return None
    if isinstance(data, AudioEvidence):
        return data
    if not isinstance(data, Mapping):
        reasons.append("audio snippet must be evidence or a mapping")
        return None
    try:
        return AudioEvidence.model_validate(data)
    except ValidationError as error:
        reasons.append(f"invalid audio snippet: {error}")
        return None


def _check_beats(
    changeset: Changeset,
    sheet: StoryPlan,
    frames: list[FrameEvidence],
    reasons: list[str],
) -> None:
    if sheet.status != "approved":
        reasons.append("beat sheet is not approved")
    known = {beat.id for beat in sheet.beats}
    for item in changeset.items:
        if item.beat_id is not None and item.beat_id not in known:
            reasons.append(f"item {item.id} cites unknown beat {item.beat_id}")
    cited = {item.beat_id for item in changeset.items if item.beat_id is not None}
    for beat in sheet.beats:
        if beat.id not in cited:
            reasons.append(f"beat {beat.id} has no edit")
        if (
            beat.start_sec is not None
            and beat.end_sec is not None
            and not any(beat.start_sec <= frame.time_s <= beat.end_sec for frame in frames)
        ):
            reasons.append(f"no frame shows beat {beat.id}")


def _check_style(
    changeset: Changeset,
    profile: StyleProfile,
    snippet: AudioEvidence | None,
    reasons: list[str],
) -> None:
    vocabulary = set(profile.stats.transition_vocabulary)
    if vocabulary:
        for item in changeset.items:
            if item.op != "add_transition":
                continue
            kind = (item.patch or {}).get("transition")
            if kind not in vocabulary:
                reasons.append(
                    f"item {item.id} uses transition {kind!r} outside the style vocabulary"
                )
    target = profile.stats.target_loudness_lufs
    if target is None:
        return
    if snippet is None or snippet.loudness_lufs is None:
        if snippet is not None:
            reasons.append("audio snippet has no loudness reading")
        return
    if abs(snippet.loudness_lufs - target) > _LOUDNESS_TOLERANCE_LUFS:
        reasons.append(
            f"audio loudness {snippet.loudness_lufs:.1f} LUFS misses "
            f"the {target:.1f} LUFS style target"
        )
