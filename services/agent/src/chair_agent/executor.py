"""Executor: fills concrete tool calls from a plan, then builds the proposal.

Every call targets the proxy; source media is never an argument. The
changeset holds pending items only: a proposed edit never changes the
timeline.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.edit_ops import Changeset, build_changeset, cut_op
from chair_agent.planner import Plan

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
) -> Changeset:
    """Build a pending changeset cutting each span out of the target clip."""
    items = [
        cut_op(
            f"cut-{index + 1}",
            target_id,
            f"Remove {span.kind} span: {span.frames} frames at {span.start_frames}",
            start_frames=span.start_frames,
            frames=span.frames,
        )
        for index, span in enumerate(merge_spans(spans))
    ]
    return build_changeset(changeset_id, base_revision, items, summary=brief)
