import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from chair_agent.executor import Span, fill_tool_calls, merge_spans
from chair_agent.jobs import HandlerResult, Job
from chair_agent.loop import LoopContext, PreviewRejected, handle_edit, run_loop
from chair_agent.planner import Plan, PlanStep, plan_brief
from chair_agent.verifier import verify

GOLDEN = json.loads((Path(__file__).parent / "golden_run.json").read_text(encoding="utf-8"))


def _golden_input():
    data = GOLDEN["input"]
    return (
        data["brief"],
        LoopContext.model_validate(data["context"]),
        [Span.model_validate(item) for item in data["spans"]],
        data["artifact_urls"],
    )


def test_golden_run_replays() -> None:
    brief, context, spans, artifact_urls = _golden_input()
    result = run_loop(brief, context, spans, artifact_urls=artifact_urls)
    assert result.model_dump(mode="json") == GOLDEN["expected"]
    assert result.verdict.accepted and result.show_to_ui


def test_planner_orders_steps_per_intent() -> None:
    silence = plan_brief("cut the silence from the proxy")
    assert silence.intents == ["silence"]
    assert [step.tool for step in silence.steps] == [
        "measure_audio",
        "editor_op",
        "render_preview",
    ]
    filler = plan_brief("remove filler words")
    assert [step.tool for step in filler.steps] == [
        "transcribe",
        "editor_op",
        "render_preview",
    ]


def test_planner_rejects_empty_and_unknown_briefs() -> None:
    with pytest.raises(ValueError):
        plan_brief("   ")
    with pytest.raises(ValueError):
        plan_brief("make it pop with a grade")


def test_executor_merges_overlapping_spans() -> None:
    merged = merge_spans(
        [
            Span(start_frames=100, frames=50, kind="silence"),
            Span(start_frames=120, frames=50, kind="filler"),
            Span(start_frames=500, frames=10, kind="filler"),
        ]
    )
    assert [(span.start_frames, span.frames) for span in merged] == [(100, 70), (500, 10)]


def test_executor_calls_target_the_proxy() -> None:
    plan = plan_brief("remove silence and filler words")
    calls = fill_tool_calls(
        plan,
        [Span(start_frames=10, frames=5, kind="silence")],
        proxy_url="file:///proxy.mp4",
    )
    assert [call.tool for call in calls] == [step.tool for step in plan.steps]
    assert all(call.args["media_url"] == "file:///proxy.mp4" for call in calls)
    editor = next(call for call in calls if call.tool == "editor_op")
    assert editor.args["cuts"] == [{"start_frames": 10, "frames": 5, "kind": "silence"}]


def test_executor_rejects_unknown_tools() -> None:
    plan = Plan(
        brief="x",
        intents=[],
        steps=[PlanStep(tool="warp_drive", goal="go faster")],
    )
    with pytest.raises(ValueError):
        fill_tool_calls(plan, [], proxy_url="file:///proxy.mp4")


def test_verifier_rejects_before_the_ui() -> None:
    brief, context, spans, artifact_urls = _golden_input()
    golden = run_loop(brief, context, spans, artifact_urls=artifact_urls)
    changeset = golden.changeset
    assert verify(changeset, artifact_urls=[], total_frames=9000).accepted is False
    assert verify({}, artifact_urls=artifact_urls, total_frames=9000).accepted is False
    assert (
        verify({**changeset, "items": []}, artifact_urls=artifact_urls,
               total_frames=9000).accepted is False
    )
    bad_cut = dict(changeset["items"][0])
    bad_cut["patch"] = {"startFrames": 8990, "frames": 50}
    assert (
        verify({**changeset, "items": [bad_cut]}, artifact_urls=artifact_urls,
               total_frames=9000).accepted is False
    )


def test_loop_gates_the_ui_on_rejection() -> None:
    brief, context, spans, _ = _golden_input()
    result = run_loop(brief, context, spans, artifact_urls=[])
    assert result.verdict.accepted is False
    assert result.show_to_ui is False
    assert result.verdict.reasons


def _job(job_input: dict) -> Job:
    return Job(
        request_id="req_test",
        task="edit",
        input=job_input,
        created_at=datetime.now(UTC),
    )


def test_handler_returns_pending_ops_on_accept() -> None:
    data = GOLDEN["input"]
    job_input = {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
        "preview_urls": data["artifact_urls"],
    }
    result = handle_edit(_job(job_input))
    assert isinstance(result, HandlerResult)
    assert result.artifacts == [{"url": data["artifact_urls"][0]}]
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)


def test_handler_rejects_and_validates_input() -> None:
    data = GOLDEN["input"]
    base = {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
    }
    with pytest.raises(PreviewRejected):
        handle_edit(_job({**base, "preview_urls": []}))
    with pytest.raises(ValueError):
        handle_edit(_job({**base, "preview_urls": data["artifact_urls"], "brief": "  "}))
