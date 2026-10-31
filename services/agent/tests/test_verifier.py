"""Verifier gate: mechanical checks plus content checks for issue #16."""

from typing import Any

import pytest
from chair_agent.beats import StoryPlan, approve, build_beat_sheet
from chair_agent.edit_ops import (
    ChangesetItem,
    build_changeset,
    cut_op,
    marker_op,
    transition_op,
)
from chair_agent.style import Exemplar, PresetRef, StyleProfile, StyleStats
from chair_agent.verifier import (
    AudioEvidence,
    FrameEvidence,
    collect_frame_evidence,
    describe_frame,
    verify,
)

ARTIFACTS = ["file:///preview.mp4"]
TOTAL_FRAMES = 9000


def _plan() -> StoryPlan:
    segments = [
        {"text": f"line {index}", "startSec": index * 4.0, "endSec": index * 4.0 + 4.0}
        for index in range(5)
    ]
    return approve(build_beat_sheet("demo cut", segments))


def _style(
    *,
    vocabulary: tuple[str, ...] = ("cut", "dissolve"),
    target_loudness: float | None = -16.0,
) -> StyleProfile:
    return StyleProfile(
        id="style_1",
        name="house",
        stats=StyleStats(
            avgShotLengthSec=4.0,
            targetLoudnessLufs=target_loudness,
            transitionVocabulary=vocabulary,
        ),
        presets=(PresetRef(name="house grade", kind="grade"),),
        exemplars=tuple(
            Exemplar(id=f"ex_{index}", summary=f"snippet {index}") for index in range(3)
        ),
    )


def _dumped(items: list[ChangesetItem]) -> dict[str, Any]:
    return build_changeset("cs_1", "rev_1", items, summary="demo").model_dump(
        mode="json", by_alias=True, exclude_none=True
    )


def _markers(plan: StoryPlan) -> list[ChangesetItem]:
    return [
        marker_op(
            f"marker_{beat.id}",
            f"Mark the {beat.role} beat.",
            name=beat.role,
            time_value=beat.start_sec or 0.0,
            time_rate=30.0,
            beat_id=beat.id,
        )
        for beat in plan.beats
    ]


def _frames(plan: StoryPlan) -> list[FrameEvidence]:
    return [
        FrameEvidence(
            time_s=(beat.start_sec or 0.0) + 1.0,
            path=f"/frames/{beat.id}.jpg",
            caption=f"{beat.role} frame",
        )
        for beat in plan.beats
        if beat.start_sec is not None and beat.end_sec is not None
    ]


def _audio(*, loudness: float | None = -16.5) -> AudioEvidence:
    return AudioEvidence(path="/audio/snippet.wav", loudness_lufs=loudness, transcript="line")


def _happy() -> dict[str, Any]:
    plan = _plan()
    return {
        "changeset": _dumped(_markers(plan)),
        "plan": plan,
        "style": _style(),
        "frames": _frames(plan),
        "audio": _audio(),
    }


def test_mechanical_gate_runs_without_content_inputs() -> None:
    plan = _plan()
    changeset = _dumped(_markers(plan))
    assert verify(changeset, artifact_urls=ARTIFACTS, total_frames=TOTAL_FRAMES).accepted is True
    assert verify(changeset, artifact_urls=[], total_frames=TOTAL_FRAMES).accepted is False
    assert verify({}, artifact_urls=ARTIFACTS, total_frames=TOTAL_FRAMES).accepted is False


def test_evidence_without_plan_or_style_is_ignored() -> None:
    plan = _plan()
    changeset = _dumped(_markers(plan))
    verdict = verify(
        changeset,
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        frames=[{"time_s": -1.0, "path": "", "caption": ""}],
        audio={"path": ""},
    )
    assert verdict.accepted is True


def test_happy_path_accepts_plan_style_frames_and_audio() -> None:
    args = _happy()
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"],
        style=args["style"],
        frames=args["frames"],
        audio=args["audio"],
    )
    assert verdict.accepted is True
    assert verdict.reasons == []


def test_raw_mappings_pass_the_gate() -> None:
    args = _happy()
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"].model_dump(mode="json", by_alias=True, exclude_none=True),
        style=args["style"].model_dump(mode="json", by_alias=True, exclude_none=True),
        frames=[frame.model_dump(mode="json", exclude_none=True) for frame in args["frames"]],
        audio=args["audio"].model_dump(mode="json", exclude_none=True),
    )
    assert verdict.accepted is True


def test_draft_beat_sheet_rejected() -> None:
    args = _happy()
    draft = args["plan"].model_copy(update={"status": "draft"})
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=draft,
        style=args["style"],
        frames=args["frames"],
        audio=args["audio"],
    )
    assert verdict.accepted is False
    assert "beat sheet is not approved" in verdict.reasons


def test_unknown_beat_cite_and_missing_beat_edit_rejected() -> None:
    plan = _plan()
    items = _markers(plan)[:4]
    items.append(
        cut_op("cut_x", "clip_1", "stray cut", start_frames=10, frames=5, beat_id="beat_nope")
    )
    verdict = verify(
        _dumped(items),
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=plan,
        style=_style(),
        frames=_frames(plan),
        audio=_audio(),
    )
    assert verdict.accepted is False
    assert "item cut_x cites unknown beat beat_nope" in verdict.reasons
    assert f"beat {plan.beats[4].id} has no edit" in verdict.reasons


def test_missing_frames_and_audio_rejected() -> None:
    args = _happy()
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"],
        style=args["style"],
    )
    assert verdict.accepted is False
    assert "no frame evidence for the preview" in verdict.reasons
    assert "no audio snippet for the preview" in verdict.reasons


def test_timed_beat_without_a_frame_rejected() -> None:
    args = _happy()
    plan = args["plan"]
    frames = _frames(plan)[:4]
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=plan,
        style=args["style"],
        frames=frames,
        audio=args["audio"],
    )
    assert verdict.accepted is False
    assert f"no frame shows beat {plan.beats[4].id}" in verdict.reasons


def test_transition_outside_style_vocabulary_rejected() -> None:
    plan = _plan()
    items = [
        *_markers(plan),
        transition_op("tr_1", "clip_1", "wipe in", kind="starwipe", duration_frames=12),
    ]
    verdict = verify(
        _dumped(items),
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=plan,
        style=_style(),
        frames=_frames(plan),
        audio=_audio(),
    )
    assert verdict.accepted is False
    assert "item tr_1 uses transition 'starwipe' outside the style vocabulary" in verdict.reasons


def test_loudness_must_sit_near_the_style_target() -> None:
    args = _happy()
    loud = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"],
        style=args["style"],
        frames=args["frames"],
        audio=_audio(loudness=-30.0),
    )
    assert loud.accepted is False
    assert any("LUFS misses" in reason for reason in loud.reasons)
    unread = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"],
        style=args["style"],
        frames=args["frames"],
        audio=_audio(loudness=None),
    )
    assert unread.accepted is False
    assert "audio snippet has no loudness reading" in unread.reasons
    untargeted = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan=args["plan"],
        style=_style(target_loudness=None),
        frames=args["frames"],
        audio=_audio(loudness=None),
    )
    assert untargeted.accepted is True


def test_invalid_content_mappings_rejected_not_raised() -> None:
    args = _happy()
    verdict = verify(
        args["changeset"],
        artifact_urls=ARTIFACTS,
        total_frames=TOTAL_FRAMES,
        plan={"nope": True},
        style={"nope": True},
        frames=[{"nope": True}],
        audio={"nope": True},
    )
    assert verdict.accepted is False
    assert any(reason.startswith("invalid beat sheet") for reason in verdict.reasons)
    assert any(reason.startswith("invalid style profile") for reason in verdict.reasons)


def test_collect_frame_evidence_fetches_each_time() -> None:
    seen: list[tuple[str, float]] = []

    class MemoryFrames:
        def fetch(self, source: str, time_s: float) -> str:
            seen.append((source, time_s))
            return f"/thumbs/{time_s:.1f}.jpg"

    evidence = collect_frame_evidence("/media/clip.mp4", [2.0, 7.5], MemoryFrames())
    assert seen == [("/media/clip.mp4", 2.0), ("/media/clip.mp4", 7.5)]
    assert [frame.path for frame in evidence] == ["/thumbs/2.0.jpg", "/thumbs/7.5.jpg"]
    assert all("\n" not in frame.caption for frame in evidence)
    assert describe_frame(time_s=2.0, path="/thumbs/2.0.jpg") == "Frame at 2.0s"
    captioned = collect_frame_evidence(
        "/media/clip.mp4",
        [1.0],
        MemoryFrames(),
        captioner=lambda *, time_s, path: f"seen {path}",
    )
    assert captioned[0].caption == "seen /thumbs/1.0.jpg"


def test_collect_frame_evidence_rejects_bad_input() -> None:
    class MemoryFrames:
        def fetch(self, source: str, time_s: float) -> str:
            return "/thumbs/x.jpg"

    with pytest.raises(ValueError):
        collect_frame_evidence("  ", [1.0], MemoryFrames())
    with pytest.raises(ValueError):
        collect_frame_evidence("/media/clip.mp4", [-1.0], MemoryFrames())
