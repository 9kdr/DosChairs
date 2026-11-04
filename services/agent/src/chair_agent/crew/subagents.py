"""Tool subagents: thin wrappers over the existing functions.

Each runner takes a validated Task and returns pending changeset items
that cite the task's beat. When the model path fails, the runner falls
back to a beat marker so the crew still lands one pending changeset;
notes always say which path ran.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from collections.abc import Mapping, Sequence

from chair_agent.crew.command import Task
from chair_agent.edit_ops import ChangesetItem, marker_op


@dataclass
class SubagentOutput:
    artifacts: list[str] = field(default_factory=list)
    items: list[ChangesetItem] = field(default_factory=list)
    notes: str = ""


def _beat_marker(task: Task, what: str) -> ChangesetItem:
    return marker_op(
        f"{task.id}-mark",
        f"{what}: {task.goal} (beat {task.beat_id})",
        name=task.beat_id,
        time_value=0.0,
        time_rate=30.0,
        kind="beat",
        beat_id=task.beat_id,
    )


def _stamp(items: Sequence[ChangesetItem], task: Task) -> list[ChangesetItem]:
    """Give every item a task-scoped id and the task's beat."""
    stamped: list[ChangesetItem] = []
    for item in items:
        stamped.append(item.model_copy(update={
            "id": f"{task.id}-{item.id}",
            "beat_id": task.beat_id,
        }))
    return stamped


def run_cut(
    task: Task,
    *,
    client: Any = None,
    target_id: str = "timeline-1",
    media: Mapping[str, Any] | None = None,
) -> SubagentOutput:
    """Cut via loop.handle_edit when media is given, else a beat marker."""
    from chair_agent import loop
    from chair_agent.jobs import Job

    if isinstance(media, Mapping) and media.get("proxy_url") and media.get("spans"):
        job = Job(
            request_id=f"crew-{task.id}",
            task="crew-cut",
            input={
                "brief": task.goal,
                "proxy_url": media["proxy_url"],
                "spans": list(media["spans"]),
                "total_frames": media.get("total_frames", 0),
                "base_revision": str(media.get("base_revision", "rev-0")),
                "target_id": target_id,
                "changeset_id": f"cs-{task.id}",
            },
            created_at=datetime.now(UTC),
        )
        result = loop.handle_edit(job, client=client)
        items = [
            ChangesetItem.model_validate(dict(op, beatId=op.get("beatId", task.beat_id)))
            if isinstance(op, Mapping) else ChangesetItem.model_validate(op)
            for op in result.ops
        ]
        return SubagentOutput(
            artifacts=[str(url) for url in result.artifacts],
            items=_stamp(items, task),
            notes="loop.handle_edit",
        )
    return SubagentOutput(items=[_beat_marker(task, "Cut point")], notes="beat marker (no media)")


def run_sound(
    task: Task,
    *,
    client: Any = None,
    beat_times: Sequence[float] = (),
) -> SubagentOutput:
    """Sound via sounds.pick_cues (rules when no key, model otherwise)."""
    from chair_agent import sounds

    entries = sounds.get_library()
    context = sounds.CueContext(
        cuts=[], beats=[float(t) for t in beat_times], words=[],
    )
    try:
        cues, picker = sounds.pick_cues(task.goal, context, entries, client=client)
        changeset = sounds.cues_to_changeset(
            cues, entries, changeset_id=f"cs-{task.id}", base_revision="rev-0",
        )
        return SubagentOutput(
            items=_stamp(list(changeset.items), task),
            notes=f"sounds.pick_cues ({picker})",
        )
    except Exception as error:
        return SubagentOutput(
            items=[_beat_marker(task, "Sound cue")],
            notes=f"beat marker (pick_cues failed: {error})",
        )


def run_motion(task: Task, *, client: Any = None, target_id: str = "timeline-1") -> SubagentOutput:
    """Motion via modules.generate_module, else a beat marker."""
    from chair_agent import modules

    try:
        record = modules.generate_module(task.goal, client=client)
        item = ChangesetItem(
            id="motion", op="add_effect", targetId=target_id, beatId=task.beat_id,
            rationale=f"Motion module {record.id}: {task.goal}",
            patch={"moduleId": record.id, "effect": "motion-module"},
        )
        return SubagentOutput(items=_stamp([item], task), notes=f"modules.generate_module ({record.id})")
    except Exception as error:
        return SubagentOutput(
            items=[_beat_marker(task, "Motion accent")],
            notes=f"beat marker (generate_module failed: {error})",
        )


def run_effects(task: Task, *, client: Any = None, target_id: str = "timeline-1") -> SubagentOutput:
    """Effects via effects.generate_effect, else a beat marker."""
    from chair_agent import effects

    try:
        record = effects.generate_effect(
            task.goal, width=1920, height=1080, fps=30, duration_sec=8, client=client,
        )
        item = ChangesetItem(
            id="effect", op="add_effect", targetId=target_id, beatId=task.beat_id,
            rationale=f"Effect {record.id}: {task.goal}",
            patch={"effectId": record.id},
        )
        return SubagentOutput(items=_stamp([item], task), notes=f"effects.generate_effect ({record.id})")
    except Exception as error:
        return SubagentOutput(
            items=[_beat_marker(task, "Effect")],
            notes=f"beat marker (generate_effect failed: {error})",
        )


def _piece_effect(task: Task, effect: str, target_id: str) -> SubagentOutput:
    from chair_agent.pieces import apply_piece_defaults, search_pieces

    hits = search_pieces(effect=effect, query=task.goal)  # type: ignore[arg-type]
    if not hits:
        raise ValueError(f"no {effect} piece matches")
    piece = hits[0].piece
    params = apply_piece_defaults(piece, {})
    item = ChangesetItem(
        id=effect, op="add_effect", targetId=target_id, beatId=task.beat_id,
        rationale=f"{piece.title}: {task.goal}",
        patch={"piece": piece.id, "effect": piece.effect, "params": params},
    )
    return SubagentOutput(items=_stamp([item], task), notes=f"piece {piece.id}")


def run_color(task: Task, *, target_id: str = "timeline-1") -> SubagentOutput:
    """Color via the grade piece, else a beat marker."""
    try:
        return _piece_effect(task, "grade", target_id)
    except Exception as error:
        return SubagentOutput(
            items=[_beat_marker(task, "Grade")],
            notes=f"beat marker (grade piece failed: {error})",
        )


def run_graphics(task: Task, *, target_id: str = "timeline-1") -> SubagentOutput:
    """Graphics via muse_image/motion_graphics pieces, else a beat marker."""
    try:
        try:
            return _piece_effect(task, "motion_graphics", target_id)
        except ValueError:
            return _piece_effect(task, "muse_image", target_id)
    except Exception as error:
        return SubagentOutput(
            items=[_beat_marker(task, "Graphic")],
            notes=f"beat marker (graphics piece failed: {error})",
        )


RUNNERS = {
    "cut": run_cut,
    "sound": run_sound,
    "motion": run_motion,
    "effects": run_effects,
    "color": run_color,
    "graphics": run_graphics,
}
