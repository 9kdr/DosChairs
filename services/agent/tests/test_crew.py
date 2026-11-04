"""Crew tests: fake client, real validators, no keys, no network."""

import httpx
import pytest
from chair_agent.beats import StoryPlan
from chair_agent.client import Completion, HttpxTransport, Message, ModelClient, RoleModels
from chair_agent.crew import run_command, run_crew
from chair_agent.crew.command import InvalidTasks, plan_beats
from chair_agent.crew.orchestrator import reset_status, status_snapshot
from chair_agent.verifier import AudioEvidence, FrameEvidence


def _plan() -> StoryPlan:
    return StoryPlan.model_validate({
        "schemaVersion": "0.1.0",
        "id": "plan-1",
        "brief": "a 20 second teaser",
        "status": "approved",
        "beats": [
            {"id": "b1", "role": "hook", "intent": "cold open",
             "startSec": 0.0, "endSec": 5.0},
            {"id": "b2", "role": "setup", "intent": "who this is for",
             "startSec": 5.0, "endSec": 10.0},
            {"id": "b3", "role": "turn", "intent": "the twist",
             "startSec": 10.0, "endSec": 15.0},
            {"id": "b4", "role": "payoff", "intent": "the promise",
             "startSec": 15.0, "endSec": 20.0},
        ],
    })


TASKS_JSON = """{"tasks": [
  {"id": "t1", "beatId": "b1", "section": "cut", "goal": "trim the cold open",
   "refs": [], "constraints": [], "acceptance": "hook lands on b1"},
  {"id": "t2", "beatId": "b2", "section": "sound", "goal": "riser under the setup",
   "refs": [], "constraints": [], "acceptance": "riser into b2"},
  {"id": "t3", "beatId": "b3", "section": "motion", "goal": "punch in on the twist",
   "refs": [], "constraints": [], "acceptance": "move lands on b3"},
  {"id": "t4", "beatId": "b4", "section": "effects", "goal": "title card on the promise",
   "refs": [], "constraints": [], "acceptance": "card reads on b4"}
]}"""


class FakeCrewClient:
    """First execute returns the task list; later calls get garbage."""

    def __init__(self, first: str) -> None:
        self._first = first
        self.calls = 0

    def execute(self, messages: list) -> Completion:
        self.calls += 1
        if self.calls <= 2:
            return Completion(model="muse-spark-1", text=self._first)
        return Completion(model="muse-spark-1", text="{}")

    def complete_model(self, model: str, messages: list) -> Completion:
        return self.execute(messages)


def _evidence():
    frames = [
        FrameEvidence(time_s=2.0, path="/tmp/f1.png", caption="hook"),
        FrameEvidence(time_s=7.0, path="/tmp/f2.png", caption="setup"),
        FrameEvidence(time_s=12.0, path="/tmp/f3.png", caption="twist"),
        FrameEvidence(time_s=17.0, path="/tmp/f4.png", caption="payoff"),
    ]
    audio = AudioEvidence(path="/tmp/a.wav", loudness_lufs=-16.0, transcript="words")
    return frames, audio


def test_brief_plus_plan_rejects_fallback_runs(monkeypatch) -> None:
    """Failing runners fall back to beat markers; the crew reports rejected."""
    monkeypatch.setattr(
        "chair_agent.sounds.get_library", lambda *args, **kwargs: []
    )
    reset_status()
    client = FakeCrewClient(TASKS_JSON)  # type: ignore[assignment]
    frames, audio = _evidence()
    run = run_crew(
        "cut a 20 second teaser", _plan(), client=client,  # type: ignore[arg-type]
        artifacts=["file:///preview.mp4"], frames=frames, audio=audio,
        total_frames=600,
    )
    assert len(run.tasks) >= 4
    assert {task.section for task in run.tasks} >= {"cut", "sound", "motion", "effects"}
    assert all(result.verdict == "rejected" for result in run.results)
    for result in run.results:
        assert result.error and "fell back" in result.error, result.task_id
    assert run.changeset is not None
    assert run.changeset.items == []
    assert run.verdict is not None
    assert not run.verdict.accepted


def test_run_task_rejects_a_beat_marker_fallback() -> None:
    from chair_agent.crew.command import Task
    from chair_agent.crew.orchestrator import run_task

    reset_status()
    task = Task(id="t1", beatId="b1", section="cut", goal="trim the cold open")
    result = run_task(task, "cold open")
    assert result.verdict == "rejected"
    assert result.error and "fell back" in result.error
    assert "no media" in result.error


def test_run_task_still_accepts_real_runner_items(monkeypatch) -> None:
    from chair_agent.crew.command import Task
    from chair_agent.crew.orchestrator import RUNNERS, reset_status, run_task
    from chair_agent.crew.subagents import SubagentOutput
    from chair_agent.edit_ops import trim_op

    def fake_cut(task, **kwargs):
        return SubagentOutput(
            items=[trim_op(
                "t1-trim", "clip-1", "Tighten the head.", start_frames=12,
                beat_id=task.beat_id,
            )],
            notes="fake cut",
        )

    monkeypatch.setitem(RUNNERS, "cut", fake_cut)
    reset_status()
    task = Task(id="t1", beatId="b1", section="cut", goal="trim the cold open")
    result = run_task(task, "cold open")
    assert result.verdict == "accepted"
    assert [item.op for item in result.items] == ["trim"]


def test_unknown_beat_id_is_rejected() -> None:
    bad = TASKS_JSON.replace('"beatId": "b1"', '"beatId": "b9"')
    client = FakeCrewClient(bad)  # type: ignore[assignment]
    with pytest.raises(InvalidTasks, match="unknown beat"):
        run_command("cut a teaser", _plan(), client)  # type: ignore[arg-type]
    assert client.calls == 2  # one repair retry


def test_unknown_section_is_rejected() -> None:
    bad = TASKS_JSON.replace('"section": "cut"', '"section": "dance"')
    client = FakeCrewClient(bad)  # type: ignore[assignment]
    with pytest.raises(InvalidTasks, match="unknown section"):
        run_command("cut a teaser", _plan(), client)  # type: ignore[arg-type]


def test_project_plan_shape_is_accepted() -> None:
    project_plan = {"phases": [{"id": "p1", "goal": "open strong"}]}
    one = '{"tasks": [{"id": "t1", "beatId": "p1", "section": "cut", "goal": "trim the open"}]}'
    client = FakeCrewClient(one)  # type: ignore[assignment]
    tasks = run_command("cut a teaser", project_plan, client)  # type: ignore[arg-type]
    assert [task.beat_id for task in tasks] == ["p1"]
    assert plan_beats({"steps": [{"id": "s1", "title": "Open"}]})[0]["id"] == "s1"


def test_health_counters_track_the_run(monkeypatch) -> None:
    monkeypatch.setattr(
        "chair_agent.sounds.get_library", lambda *args, **kwargs: []
    )
    reset_status()
    client = FakeCrewClient(TASKS_JSON)  # type: ignore[assignment]
    frames, audio = _evidence()
    run_crew(
        "cut a 20 second teaser", _plan(), client=client,  # type: ignore[arg-type]
        artifacts=["file:///preview.mp4"], frames=frames, audio=audio,
        total_frames=600,
    )
    snapshot = status_snapshot()
    assert snapshot["tasks_queued"] >= 4
    assert snapshot["tasks_done"] == 0
    assert snapshot["tasks_failed"] >= 4
    assert snapshot["last_latency_ms"] is not None


def test_complete_model_uses_the_named_model() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})

    client = ModelClient(
        models=RoleModels(
            planner="muse-wonder-1.0", executor="muse-spark-1", verifier="muse-spark-1"),
        transport=HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler))),
        api_key="test-key",
    )
    completion = client.complete_model("muse-wonder-2", [Message(role="user", content="go")])
    assert completion == Completion(model="muse-wonder-2", text="hi")
    import json as _json

    assert _json.loads(seen[0].content)["model"] == "muse-wonder-2"
    with pytest.raises(ValueError):
        client.complete_model("  ", [Message(role="user", content="go")])
