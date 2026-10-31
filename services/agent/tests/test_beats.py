import pytest
from chair_agent.beats import (
    InvalidStoryPlan,
    StoryPlan,
    UnknownBeat,
    approve,
    beats_to_markers,
    build_beat_sheet,
    edit_beat,
    get_beat,
    validate_story_plan,
)
from chair_agent.edit_ops import build_changeset, cut_op, validate_changeset

BRIEF = "A sixty-second cut about dawn bread runs."


def _segments(count: int = 10) -> list[dict]:
    return [
        {"text": f"Line {index} about the bake.", "startSec": index * 6.0,
         "endSec": index * 6.0 + 6.0}
        for index in range(count)
    ]


def _approved() -> StoryPlan:
    return approve(build_beat_sheet(BRIEF, _segments()))


def test_build_makes_five_beats_in_role_order() -> None:
    plan = build_beat_sheet(BRIEF, _segments(), plan_id="story_1")
    assert plan.id == "story_1"
    assert plan.status == "draft"
    assert [beat.role for beat in plan.beats] == ["hook", "setup", "turn", "payoff", "outro"]
    assert [beat.id for beat in plan.beats] == [
        "beat_hook", "beat_setup", "beat_turn", "beat_payoff", "beat_outro",
    ]
    assert plan.beats[0].start_sec == 0.0
    assert plan.beats[-1].end_sec == 60.0
    assert plan.target_duration_sec == 60.0


def test_built_plan_validates_against_the_schema() -> None:
    plan = build_beat_sheet(BRIEF, _segments())
    validated = validate_story_plan(plan.model_dump(by_alias=True, exclude_none=True))
    assert validated.id == plan.id
    with pytest.raises(InvalidStoryPlan):
        validate_story_plan({"id": "nope"})


def test_build_rejects_empty_brief_or_segments() -> None:
    with pytest.raises(InvalidStoryPlan):
        build_beat_sheet("  ", _segments())
    with pytest.raises(InvalidStoryPlan):
        build_beat_sheet(BRIEF, [])
    with pytest.raises(InvalidStoryPlan):
        build_beat_sheet(BRIEF, [{"text": ""}])


def test_build_covers_short_transcripts() -> None:
    plan = build_beat_sheet(BRIEF, _segments(2))
    assert [beat.role for beat in plan.beats] == ["hook", "setup", "turn", "payoff", "outro"]
    assert all(beat.intent for beat in plan.beats)


def test_edit_changes_one_beat_and_returns_to_draft() -> None:
    plan = _approved()
    assert plan.status == "approved"
    revised = edit_beat(
        plan, "beat_hook", intent="Open on the oven door.",
        pacing="fast", candidate_clip_ids=["clip_9"], start_sec=1.5,
    )
    assert revised.status == "draft"
    assert get_beat(revised, "beat_hook").intent == "Open on the oven door."
    assert get_beat(revised, "beat_hook").pacing == "fast"
    assert get_beat(revised, "beat_hook").candidate_clip_ids == ["clip_9"]
    assert get_beat(revised, "beat_hook").start_sec == 1.5
    assert get_beat(revised, "beat_setup").intent == get_beat(plan, "beat_setup").intent


def test_edit_rejects_unknown_beats_and_bad_values() -> None:
    plan = _approved()
    with pytest.raises(UnknownBeat):
        edit_beat(plan, "beat_missing", intent="Nope.")
    with pytest.raises(UnknownBeat):
        get_beat(plan, "beat_missing")
    with pytest.raises(InvalidStoryPlan):
        edit_beat(plan, "beat_hook", intent="")
    with pytest.raises(InvalidStoryPlan):
        edit_beat(plan, "beat_hook", pacing="ludicrous")


def test_approve_needs_all_five_roles() -> None:
    plan = build_beat_sheet(BRIEF, _segments())
    short = plan.model_copy(update={"beats": plan.beats[:4]})
    with pytest.raises(InvalidStoryPlan):
        approve(short)
    assert approve(plan).status == "approved"


def test_markers_need_approval_and_start_times() -> None:
    draft = build_beat_sheet(BRIEF, _segments())
    with pytest.raises(InvalidStoryPlan):
        beats_to_markers(draft, rate=24.0)
    untimed = build_beat_sheet(BRIEF, [{"text": "No times here."}])
    with pytest.raises(InvalidStoryPlan):
        beats_to_markers(approve(untimed), rate=24.0)
    with pytest.raises(ValueError):
        beats_to_markers(_approved(), rate=0)


def test_markers_cite_beats_and_validate() -> None:
    items = beats_to_markers(_approved(), rate=24.0)
    assert [item.beat_id for item in items] == [
        "beat_hook", "beat_setup", "beat_turn", "beat_payoff", "beat_outro",
    ]
    assert all(item.status == "pending" for item in items)
    assert [item.patch["marker"]["kind"] for item in items] == [
        "hook", "beat", "beat", "beat", "beat",
    ]
    assert items[0].patch["marker"]["time"] == {"value": 0.0, "rate": 24.0}
    changeset = build_changeset("cs_beats", "rev_0", items)
    validated = validate_changeset(changeset.model_dump(by_alias=True, exclude_none=True))
    assert len(validated.items) == 5


def test_later_edits_cite_a_beat() -> None:
    plan = _approved()
    hook = get_beat(plan, "beat_hook").id
    items = [
        *beats_to_markers(plan, rate=24.0),
        cut_op("item_cut", "clip_1", "Cut the cough.", start_frames=10, frames=24,
               beat_id=hook),
    ]
    validated = validate_changeset(
        build_changeset("cs_1", "rev_0", items).model_dump(
            by_alias=True, exclude_none=True, mode="json")
    )
    assert validated.items[-1].beat_id == "beat_hook"
