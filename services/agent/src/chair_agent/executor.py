"""Executor: fills concrete tool calls from a plan, then builds the proposal.

Every call targets the proxy; source media is never an argument. The
changeset holds pending items only: a proposed edit never changes the
timeline. Sound-design intents become SFX and ducking items on a NEW audio
track; an intent the executor cannot dispatch comes back as a skipped entry
with a plain reason instead of silently vanishing.
"""

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.edit_ops import (
    Changeset,
    ChangesetItem,
    build_changeset,
    cut_op,
    duck_op,
    sfx_clip_op,
    sfx_track_op,
)
from chair_agent.planner import CANONICAL_INTENTS, SOUND_INTENTS, Plan


def canonical_intent(intent: str) -> str:
    """Map a planner intent to its canonical spelling by keyword.

    The model invents variants ("tape_stop_out"), so exact-matching drops
    real plans. Keywords win: riser, tape+stop, duck, silence, filler.
    Unknown intents pass through unchanged for the skipped report.
    """
    if intent in CANONICAL_INTENTS:
        return intent
    lowered = intent.lower()
    if "riser" in lowered or "buildup" in lowered or "build-up" in lowered:
        return "riser_into_cut"
    if "tape" in lowered and "stop" in lowered:
        return "tape_stop_outro"
    if "duck" in lowered:
        return "duck_music_under_dialogue"
    if "silence" in lowered or "silent" in lowered:
        return "silence"
    if "filler" in lowered:
        return "filler"
    return intent


def canonical_intents(intents: list[str]) -> list[str]:
    """Canonical spelling per intent, order kept, duplicates dropped."""
    seen: list[str] = []
    for intent in intents:
        canon = canonical_intent(intent)
        if canon not in seen:
            seen.append(canon)
    return seen

SpanKind = Literal["silence", "filler"]


class Span(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    start_frames: int = Field(ge=0)
    frames: int = Field(gt=0)
    kind: SpanKind


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tool: str
    goal: str
    args: dict[str, Any]


class SfxFile(BaseModel):
    """One resolved sound file: library pick or sidecar synth render."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: str = Field(min_length=1)
    path: str = Field(min_length=1)
    name: str = Field(min_length=1)
    duration_seconds: float = Field(gt=0)
    source: str = Field(default="synth")
    license: str = Field(default="generated")
    gain_db: float = Field(default=-10.0, le=0)


class SkippedIntent(BaseModel):
    """An intent the executor could not dispatch, with the plain reason why."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    intent: str = Field(min_length=1)
    reason: str = Field(min_length=1)


def merge_spans(spans: list[Span]) -> list[Span]:
    """Sort spans and merge overlaps into single cuts. First kind wins."""
    merged: list[Span] = []
    for span in sorted(spans, key=lambda item: (item.start_frames, item.frames)):
        if merged and span.start_frames <= merged[-1].start_frames + merged[-1].frames:
            last = merged[-1]
            end = max(last.start_frames + last.frames, span.start_frames + span.frames)
            merged[-1] = Span(start_frames=last.start_frames, frames=end - last.start_frames,
                              kind=last.kind)
        else:
            merged.append(span)
    return merged


def fill_tool_calls(plan: Plan, spans: list[Span], *, proxy_url: str) -> list[ToolCall]:
    """Fill one concrete tool call per plan step. Cuts ride on editor_op."""
    if not proxy_url.strip():
        raise ValueError("proxy_url must be a non-empty string")
    cuts = [span.model_dump(mode="json") for span in merge_spans(spans)]
    calls = []
    for step in plan.steps:
        if step.tool == "measure_audio":
            args: dict[str, Any] = {"media_url": proxy_url, "detect": ["silence"]}
        elif step.tool == "transcribe":
            args = {"media_url": proxy_url, "word_timing": True}
        elif step.tool == "editor_op":
            args = {"media_url": proxy_url, "cuts": cuts}
        elif step.tool == "render_preview":
            args = {"media_url": proxy_url}
        else:
            raise ValueError(f"executor cannot fill tool: {step.tool!r}")
        calls.append(ToolCall(tool=step.tool, goal=step.goal, args=args))
    return calls


def cuts_to_changeset(
    spans: list[Span],
    *,
    changeset_id: str,
    base_revision: str,
    target_id: str,
    brief: str,
    intents: list[str] | tuple[str, ...] | None = None,
) -> Changeset:
    """Build a pending changeset cutting each span out of the target clip.

    When intents are given, only spans whose kind the intents name are cut:
    silence spans measured for ducking (not for cutting) stay out of the
    blades. Without intents every span is cut, as before.
    """
    wanted = list(merge_spans(spans))
    if intents is not None:
        canon = canonical_intents(list(intents))
        kinds = {"silence"} if "silence" in canon else set()
        if "filler" in canon:
            kinds.add("filler")
        wanted = [span for span in wanted if span.kind in kinds]
    items = [
        cut_op(
            f"cut-{index + 1}",
            target_id,
            f"Remove {span.kind} span: {span.frames} frames at {span.start_frames}",
            start_frames=span.start_frames,
            frames=span.frames,
        )
        for index, span in enumerate(wanted)
    ]
    return build_changeset(changeset_id, base_revision, items, summary=brief)


_TIMECODE_RE = re.compile(r"(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)")
_MIN_SEC_RE = re.compile(r"(\d+):(\d{1,2}(?:\.\d+)?)")
_SECONDS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b")


def sound_moment(brief: str) -> float | None:
    """First time-like token in the brief, in seconds (cut time for a riser).

    Reads 00:00:05, 0:05, and '5s' shapes. None when the brief names no time.
    """
    match = _TIMECODE_RE.search(brief)
    if match:
        hours, minutes, seconds = match.groups()
        return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)
    match = _MIN_SEC_RE.search(brief)
    if match:
        minutes, seconds = match.groups()
        return round(int(minutes) * 60 + float(seconds), 3)
    match = _SECONDS_RE.search(brief)
    if match:
        return round(float(match.group(1)), 3)
    return None


def dialogue_regions(
    spans: list[Span], total_frames: int
) -> list[tuple[int, int]]:
    """Silence inverted: frame ranges where someone is (probably) talking.

    Merged silence spans are cut out of [0, total); slivers under one frame
    wide are dropped. Empty when there is nothing to invert.
    """
    if total_frames <= 0:
        return []
    bounds = sorted(
        (span.start_frames, span.start_frames + span.frames)
        for span in merge_spans(spans)
        if span.kind == "silence"
    )
    regions: list[tuple[int, int]] = []
    cursor = 0
    for start, end in bounds:
        if start > cursor:
            regions.append((cursor, min(start, total_frames)))
        cursor = max(cursor, end)
    if cursor < total_frames:
        regions.append((cursor, total_frames))
    return [(start, end) for start, end in regions if end - start >= 1]


def sound_changeset_items(
    brief: str,
    intents: list[str],
    spans: list[Span],
    *,
    total_frames: int,
    rate: float,
    sfx: dict[str, SfxFile],
    duck_target_id: str,
    track_id: str = "audio-sfx-1",
) -> tuple[list[ChangesetItem], list[SkippedIntent]]:
    """Turn sound intents into SFX + ducking items on a NEW audio track.

    Returns (items, skipped): every intent that cannot dispatch — no SFX
    file, no cut time, no dialogue regions — comes back as a skipped entry
    with a plain reason instead of silently dropping out of the job.
    """
    if rate <= 0:
        raise ValueError("sound items need a rate above 0")
    items: list[ChangesetItem] = []
    skipped: list[SkippedIntent] = []
    wanted = [intent for intent in canonical_intents(intents) if intent in SOUND_INTENTS]
    if not wanted:
        return items, skipped
    total_seconds = total_frames / rate if total_frames > 0 else 0.0

    if "riser_into_cut" in wanted:
        moment = sound_moment(brief)
        if moment is None:
            skipped.append(SkippedIntent(
                intent="riser_into_cut",
                reason="riser needs a cut time: say 'riser into the cut at 00:00:05'",
            ))
        elif total_seconds > 0 and moment > total_seconds:
            skipped.append(SkippedIntent(
                intent="riser_into_cut",
                reason=f"the cut at {moment:.2f}s is past the {total_seconds:.2f}s timeline",
            ))
        else:
            placed, skip = _place_sfx(
                "riser_into_cut", "riser", moment or 0.0, sfx,
                track_id=track_id, rate=rate, pre_hit=True,
            )
            items.extend(placed)
            skipped.extend(skip)

    if "tape_stop_outro" in wanted:
        if total_seconds <= 0:
            skipped.append(SkippedIntent(
                intent="tape_stop_outro",
                reason="tape stop needs the timeline length, which is unknown",
            ))
        else:
            placed, skip = _place_sfx(
                "tape_stop_outro", "tape-stop", total_seconds, sfx,
                track_id=track_id, rate=rate, pre_hit=False,
            )
            items.extend(placed)
            skipped.extend(skip)

    if "duck_music_under_dialogue" in wanted:
        regions = dialogue_regions(spans, total_frames)
        if not regions:
            skipped.append(SkippedIntent(
                intent="duck_music_under_dialogue",
                reason="ducking needs dialogue regions: no silence spans to invert",
            ))
        else:
            seconds = [(s / rate, e / rate) for s, e in regions]
            items.append(duck_op(
                "duck-1", duck_target_id,
                f"Duck music under {len(seconds)} dialogue region(s), -12 dB.",
                regions_seconds=seconds,
            ))

    if any(item.op == "add_clip" for item in items):
        items.insert(0, sfx_track_op(
            "track-sfx-1", "New audio track for sound cues.",
            track_id=track_id,
        ))
    return items, skipped


def _place_sfx(
    intent: str,
    kind: str,
    moment: float,
    sfx: dict[str, SfxFile],
    *,
    track_id: str,
    rate: float,
    pre_hit: bool,
) -> tuple[list[ChangesetItem], list[SkippedIntent]]:
    """Place one SFX file so its transient lands on the moment.

    Pre-hit kinds (risers) end on the moment: start = moment - duration.
    Hit kinds (tape stops) start on it. Missing files and negative starts
    skip with a plain reason.
    """
    entry = sfx.get(kind)
    if entry is None:
        return [], [SkippedIntent(
            intent=intent,
            reason=f"no {kind} sound available: add one to the sound library",
        )]
    duration = entry.duration_seconds
    start = moment - duration if pre_hit else moment
    if pre_hit and start < 0:
        if moment <= 0:
            return [], [SkippedIntent(
                intent=intent,
                reason=f"the {kind} is {duration:.1f}s but the cut is at {moment:.2f}s",
            )]
        duration = moment
        start = 0.0
    clip_id = f"sfx-{kind.replace('-', '')}-1"
    return [sfx_clip_op(
        f"sfx-{kind}-1", track_id, clip_id,
        f"{entry.name} lands on {moment:.2f}s.",
        media_ref=entry.path,
        name=entry.name,
        start_seconds=round(start, 3),
        duration_seconds=round(duration, 3),
        rate=rate,
        gain_db=entry.gain_db,
        kind=kind,
        source=entry.source,
        license=entry.license,
    )], []
