"""Per-task orchestrator: brief, run, section-verify, retry once, merge.

Each task gets one short Spark call to write its subagent brief, then
runs through its section wrapper. Section verify checks the items look
like that section's work; one retry runs before the task is marked
rejected. Merge runs a plan-coverage check via verifier.verify plus a
short drift check, then folds every accepted task into ONE pending
changeset that applies to a copy. Undo stays via the existing history.
"""

import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from chair_agent.client import Message, ModelClient
from chair_agent.crew.command import SECTIONS, Task, plan_beats, run_command
from chair_agent.crew.result import TaskResult
from chair_agent.crew.subagents import RUNNERS
from chair_agent.edit_ops import Changeset, ChangesetItem, build_changeset, validate_changeset
from chair_agent.verifier import Verdict

_SECTION_OPS: dict[str, set[str]] = {
    "cut": {"add_marker", "remove_clip", "trim", "ripple", "move", "set_speed",
            "add_transition", "add_clip"},
    "sound": {"add_track", "add_clip", "set_gain", "mute_clip", "add_marker"},
    "motion": {"add_clip", "add_transition", "add_effect", "add_marker"},
    "effects": {"add_effect", "add_clip", "add_marker"},
    "color": {"add_effect", "add_clip", "add_marker"},
    "graphics": {"add_clip", "add_effect", "add_marker", "add_track"},
}

_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "per_section": {name: {"queued": 0, "done": 0, "failed": 0} for name in SECTIONS},
    "last_error": None,
    "last_latency_ms": None,
}


def _note(*, section: str | None = None, done: bool = False,
          failed: bool = False, error: str | None = None,
          latency_ms: float | None = None) -> None:
    with _STATUS_LOCK:
        if section in _STATUS["per_section"]:
            if done:
                _STATUS["per_section"][section]["done"] += 1
            if failed:
                _STATUS["per_section"][section]["failed"] += 1
        if error is not None:
            _STATUS["last_error"] = error
        if latency_ms is not None:
            _STATUS["last_latency_ms"] = latency_ms


def status_snapshot() -> dict[str, Any]:
    """Crew counters for /health: tasks queued/done/failed per section."""
    with _STATUS_LOCK:
        return {
            "tasks_queued": sum(s["queued"] for s in _STATUS["per_section"].values()),
            "tasks_done": sum(s["done"] for s in _STATUS["per_section"].values()),
            "tasks_failed": sum(s["failed"] for s in _STATUS["per_section"].values()),
            "per_section": {k: dict(v) for k, v in _STATUS["per_section"].items()},
            "last_error": _STATUS["last_error"],
            "last_latency_ms": _STATUS["last_latency_ms"],
        }


def reset_status() -> None:
    with _STATUS_LOCK:
        for counts in _STATUS["per_section"].values():
            counts["queued"] = counts["done"] = counts["failed"] = 0
        _STATUS["last_error"] = None
        _STATUS["last_latency_ms"] = None


def build_brief(task: Task, beat_label: str, client: ModelClient | None) -> str:
    """One short Spark call turns the task into a subagent brief."""
    fallback = (
        f"{task.section}: {task.goal} (beat {task.beat_id}: {beat_label}). "
        f"Done when: {task.acceptance or task.goal}."
    )
    if client is None:
        return fallback
    try:
        completion = client.execute([
            Message(role="developer", content=(
                "Write a one-paragraph brief for a video-editing tool subagent. "
                "Name the section, the goal, the beat, and the one check that "
                "proves it is done. Plain words, no JSON."
            )),
            Message(role="user", content=(
                f"Section: {task.section}\nGoal: {task.goal}\n"
                f"Beat {task.beat_id}: {beat_label}\n"
                f"Constraints: {'; '.join(task.constraints) or 'none'}\n"
                f"Acceptance: {task.acceptance or task.goal}"
            )),
        ])
        text = completion.text.strip()
        return text or fallback
    except Exception:
        return fallback


def section_verify(task: Task, items: Sequence[ChangesetItem]) -> list[str]:
    """Check the items look like this section's work on this task's beat."""
    problems: list[str] = []
    if not items:
        return ["no items emitted"]
    allowed = _SECTION_OPS.get(task.section, set())
    for item in items:
        if item.status != "pending":
            problems.append(f"item {item.id} is {item.status}, not pending")
        if item.beat_id != task.beat_id:
            problems.append(f"item {item.id} does not cite beat {task.beat_id}")
        if item.op not in allowed:
            problems.append(f"item {item.id} op {item.op} is not {task.section} work")
    return problems


def run_task(
    task: Task,
    beat_label: str,
    *,
    client: ModelClient | None = None,
    target_id: str = "timeline-1",
    media: Mapping[str, Any] | None = None,
    beat_times: Sequence[float] = (),
) -> TaskResult:
    """Run one task: brief, subagent, section-verify, retry once."""
    started = time.perf_counter()
    runner = RUNNERS.get(task.section)
    if runner is None:
        error = f"unknown section {task.section!r}"
        _note(section=task.section, failed=True, error=error,
              latency_ms=round((time.perf_counter() - started) * 1000, 1))
        return TaskResult(task_id=task.id, section=task.section, verdict="rejected", error=error)
    brief = build_brief(task, beat_label, client)
    attempt_notes: list[str] = []
    current = task
    for attempt in ("first", "retry"):
        try:
            if task.section == "cut":
                output = runner(current, client=client, target_id=target_id, media=media)  # type: ignore[call-arg]
            elif task.section == "sound":
                output = runner(current, client=client, beat_times=beat_times)  # type: ignore[call-arg]
            elif task.section in ("color", "graphics"):
                output = runner(current, target_id=target_id)  # type: ignore[call-arg]
            else:
                output = runner(current, client=client, target_id=target_id)  # type: ignore[call-arg]
        except Exception as error:
            attempt_notes.append(f"{attempt} raised {type(error).__name__}: {error}")
            current = task.model_copy(update={"goal": f"{task.goal} (retry: {error})"})
            continue
        problems = section_verify(task, output.items)
        if problems:
            attempt_notes.append(f"{attempt} failed verify: {'; '.join(problems)}")
            current = task.model_copy(update={"goal": f"{task.goal} (retry: {problems[-1]})"})
            continue
        latency = round((time.perf_counter() - started) * 1000, 1)
        _note(section=task.section, done=True, latency_ms=latency)
        return TaskResult(
            task_id=task.id, section=task.section,
            artifacts=list(output.artifacts), items=list(output.items),
            verdict="accepted", notes=output.notes,
        )
    latency = round((time.perf_counter() - started) * 1000, 1)
    error = "; ".join(attempt_notes) or "task failed"
    _note(section=task.section, failed=True, error=error, latency_ms=latency)
    return TaskResult(task_id=task.id, section=task.section, verdict="rejected",
                      notes=brief, error=error)


def drift_check(items: Sequence[ChangesetItem], timeline: Mapping[str, Any] | None) -> list[str]:
    """Short drift check: items still target clips/tracks on the copy."""
    if timeline is None:
        return []
    known: set[str] = set()
    for key in ("clips", "tracks", "children"):
        group = timeline.get(key)
        if isinstance(group, list):
            for entry in group:
                if isinstance(entry, Mapping) and isinstance(entry.get("id"), str):
                    known.add(entry["id"])
        elif isinstance(group, Mapping):
            known.update(k for k in group if isinstance(k, str))
    for key in ("id", "name", "targetId"):
        value = timeline.get(key)
        if isinstance(value, str):
            known.add(value)
    problems = []
    for item in items:
        if item.target_id is not None and item.target_id not in known:
            problems.append(f"item {item.id} targets {item.target_id!r}, gone from the copy")
    return problems


def merge_results(
    results: Sequence[TaskResult],
    plan: Any,
    *,
    changeset_id: str = "cs-crew-1",
    base_revision: str = "rev-0",
    total_frames: int = 900,
    artifacts: Sequence[str] = (),
    frames: Sequence[Any] = (),
    audio: Any | None = None,
    timeline: Mapping[str, Any] | None = None,
) -> tuple[Changeset, Verdict]:
    """Fold accepted tasks into ONE pending changeset with a verdict."""
    from chair_agent import verifier

    items: list[ChangesetItem] = []
    for result in results:
        if result.verdict == "accepted":
            items.extend(result.items)
    merged = build_changeset(changeset_id, base_revision, items, summary="Crew cut")
    merged = validate_changeset(merged.model_dump(mode="json", by_alias=True, exclude_none=True))
    reasons: list[str] = []
    try:
        beats = plan_beats(plan)
        cited = {item.beat_id for item in merged.items if item.beat_id}
        for beat in beats:
            if beat["id"] not in cited:
                reasons.append(f"beat {beat['id']} has no edit")
    except Exception as error:
        reasons.append(f"plan coverage unreadable: {error}")
    reasons.extend(drift_check(merged.items, timeline))
    check = verifier.verify(
        merged.model_dump(mode="json", by_alias=True, exclude_none=True),
        artifact_urls=list(artifacts),
        total_frames=total_frames,
        plan=plan if not isinstance(plan, Mapping) or "beats" in plan else None,
        frames=frames,
        audio=audio,
    )
    reasons.extend(check.reasons)
    return merged, Verdict(accepted=not reasons, reasons=reasons)


@dataclass
class CrewRun:
    tasks: list[Task] = field(default_factory=list)
    results: list[TaskResult] = field(default_factory=list)
    changeset: Changeset | None = None
    verdict: Verdict | None = None


def run_crew(
    brief: str,
    plan: Any,
    *,
    client: ModelClient | None = None,
    model: str | None = None,
    changeset_id: str = "cs-crew-1",
    base_revision: str = "rev-0",
    target_id: str = "timeline-1",
    total_frames: int = 900,
    artifacts: Sequence[str] = (),
    frames: Sequence[Any] = (),
    audio: Any | None = None,
    timeline: Mapping[str, Any] | None = None,
) -> CrewRun:
    """Brief plus plan to one pending changeset with a verdict."""
    tasks = run_command(brief, plan, client, model=model)
    with _STATUS_LOCK:
        for task in tasks:
            if task.section in _STATUS["per_section"]:
                _STATUS["per_section"][task.section]["queued"] += 1
    labels = {beat["id"]: beat["label"] for beat in plan_beats(plan)}
    beat_times = _beat_times(plan)
    results = [
        run_task(task, labels.get(task.beat_id, task.beat_id), client=client,
                 target_id=target_id, beat_times=beat_times)
        for task in tasks
    ]
    changeset, verdict = merge_results(
        results, plan, changeset_id=changeset_id, base_revision=base_revision,
        total_frames=total_frames, artifacts=artifacts, frames=frames,
        audio=audio, timeline=timeline,
    )
    return CrewRun(tasks=tasks, results=results, changeset=changeset, verdict=verdict)


def _beat_times(plan: Any) -> list[float]:
    times: list[float] = []
    if hasattr(plan, "beats"):
        raw: Any = plan.beats
    elif isinstance(plan, Mapping):
        raw = plan.get("beats")
    else:
        raw = None
    if isinstance(raw, list):
        for entry in raw:
            moment = getattr(entry, "start_sec", None)
            if moment is None and isinstance(entry, Mapping):
                moment = entry.get("startSec", entry.get("start_sec"))
            if isinstance(moment, (int, float)):
                times.append(float(moment))
    return times


def handle_direct(job: Any) -> Any:
    """Job handler for the 'direct' task: brief plus plan in, proposal out."""
    from chair_agent.client import build_client
    from chair_agent.jobs import HandlerResult

    brief = job.input.get("brief", "")
    plan = job.input.get("plan")
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("job input needs a non-empty 'brief' string")
    if not isinstance(plan, Mapping):
        raise ValueError("job input needs a 'plan' object")
    run = run_crew(
        brief, plan,
        client=build_client(),
        changeset_id=str(job.input.get("changeset_id") or f"cs-{job.request_id}"),
        base_revision=str(job.input.get("base_revision") or "rev-0"),
        target_id=str(job.input.get("target_id") or "timeline-1"),
        total_frames=int(job.input.get("total_frames") or 900),
    )
    assert run.changeset is not None and run.verdict is not None
    verdict = "accepted" if run.verdict.accepted else "rejected"
    listing = ", ".join(f"{task.section}:{task.id}" for task in run.tasks)
    return HandlerResult(
        artifacts=[],
        ops=[item.model_dump(mode="json", by_alias=True) for item in run.changeset.items],
        planner="crew",
        message=(f"crew {verdict}: {len(run.tasks)} tasks [{listing}], "
                 f"{'; '.join(run.verdict.reasons) or 'all beats covered'}"),
    )
