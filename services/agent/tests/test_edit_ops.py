import json
from pathlib import Path

import pytest
from chair_agent.edit_ops import (
    ChangesetItem,
    InvalidChangeset,
    build_changeset,
    cut_op,
    marker_op,
    move_op,
    ripple_op,
    speed_op,
    transition_op,
    trim_op,
    validate_changeset,
)

ROOT = Path(__file__).resolve().parents[3]


def _all_ops(beat_id: str | None = "beat_hook") -> list[ChangesetItem]:
    return [
        cut_op("item_cut", "clip_1", "Cut the cough.", start_frames=10, frames=24,
               beat_id=beat_id),
        trim_op("item_trim", "clip_1", "Tighten the head.", start_frames=18,
                beat_id=beat_id),
        ripple_op("item_ripple", "clip_2", "Close the gap.", shift_frames=-24,
                  beat_id=beat_id),
        move_op("item_move", "clip_3", "B-roll over the turn.", to_track_id="v2",
                start_frames=480, beat_id=beat_id),
        speed_op("item_speed", "clip_4", "Slow push on the payoff.", rate=0.5,
                 beat_id=beat_id),
        transition_op("item_trans", "clip_5", "Soften the join.", kind="dissolve",
                      duration_frames=12, beat_id=beat_id),
        marker_op("item_marker", "Mark the hook.", name="Hook",
                  time_value=12.0, time_rate=24.0, kind="hook", beat_id=beat_id),
    ]


def _dumped(items: list[ChangesetItem]) -> dict:
    changeset = build_changeset("cs_1", "rev_0", items, summary="Tighten the hook")
    return changeset.model_dump(by_alias=True, exclude_none=True, mode="json")


def test_every_op_maps_to_its_schema_op() -> None:
    ops = [item.op for item in _all_ops()]
    assert ops == [
        "remove_clip", "trim", "ripple", "move", "set_speed", "add_transition",
        "add_marker",
    ]


def test_every_op_validates_against_the_changeset_schema() -> None:
    validated = validate_changeset(_dumped(_all_ops()))
    assert [item.id for item in validated.items] == [
        "item_cut", "item_trim", "item_ripple", "item_move", "item_speed",
        "item_trans", "item_marker",
    ]


def test_emitted_items_are_pending_and_cite_the_beat() -> None:
    for item in _all_ops(beat_id="beat_hook"):
        dumped = item.model_dump(by_alias=True, exclude_none=True, mode="json")
        assert dumped["status"] == "pending"
        assert dumped["beatId"] == "beat_hook"


def test_beat_id_is_absent_when_there_is_no_beat() -> None:
    for item in _all_ops(beat_id=None):
        dumped = item.model_dump(by_alias=True, exclude_none=True, mode="json")
        assert "beatId" not in dumped
    assert "beatId" not in _dumped(_all_ops(beat_id=None))["items"][0]


def test_marker_patch_carries_the_marker_object() -> None:
    dumped = marker_op(
        "item_marker", "Mark the hook.", name="Hook",
        time_value=12.0, time_rate=24.0, kind="hook", beat_id="beat_hook",
    ).model_dump(by_alias=True, exclude_none=True, mode="json")
    assert dumped["patch"]["marker"] == {
        "id": "item_marker",
        "name": "Hook",
        "time": {"value": 12.0, "rate": 24.0},
        "kind": "hook",
        "beatId": "beat_hook",
    }


def test_builders_reject_bad_ranges() -> None:
    with pytest.raises(ValueError):
        cut_op("x", "clip_1", "Cut.", start_frames=-1, frames=24)
    with pytest.raises(ValueError):
        trim_op("x", "clip_1", "Trim.")
    with pytest.raises(ValueError):
        ripple_op("x", "clip_1", "Ripple.", shift_frames=0)
    with pytest.raises(ValueError):
        speed_op("x", "clip_1", "Speed.", rate=0.0)


def test_invalid_tool_output_is_rejected_before_the_ui() -> None:
    good = _dumped(_all_ops())
    cases = [
        {**good, "schemaVersion": "9.9.9"},
        {**good, "items": [{**good["items"][0], "op": "teleport"}]},
        {**good, "items": [{**good["items"][0], "status": "maybe"}]},
        {**good, "items": [
            {k: v for k, v in good["items"][0].items() if k != "rationale"}
        ]},
        {**good, "items": [{**good["items"][0], "sneaky": True}]},
        {**good, "items": "not-a-list"},
    ]
    for bad in cases:
        with pytest.raises(InvalidChangeset):
            validate_changeset(bad)
    with pytest.raises(InvalidChangeset):
        validate_changeset("not-an-object")  # type: ignore[arg-type]


def test_fixture_changeset_validates() -> None:
    fixture = json.loads((ROOT / "fixtures/timelines/example.changeset.json").read_text())
    assert validate_changeset(fixture).id == "cs_example"


def test_fallback_travels_with_capability_and_reason() -> None:
    item = ChangesetItem(
        id="item_fx",
        op="add_effect",
        rationale="Kinetic type over the hook.",
        fallback={
            "capability": "fusionComps",
            "reason": "Resolve can't place this directly — pre-rendered clip instead",
        },
    )
    validated = validate_changeset(_dumped([item]))
    assert validated.items[0].fallback is not None
    assert validated.items[0].fallback.capability == "fusionComps"
    assert validated.items[0].fallback.reason == (
        "Resolve can't place this directly — pre-rendered clip instead"
    )


def test_fallback_without_reason_is_rejected_before_the_ui() -> None:
    good = _dumped(_all_ops())
    cases = [
        {**good, "items": [{**good["items"][0], "fallback": {"capability": "fusionComps"}}]},
        {
            **good,
            "items": [
                {**good["items"][0], "fallback": {"capability": "fusionComps", "reason": ""}}
            ],
        },
    ]
    for bad in cases:
        with pytest.raises(InvalidChangeset):
            validate_changeset(bad)


def test_removal_ops_validate_for_undo_changesets() -> None:
    ops = ["remove_marker", "remove_effect", "remove_transition", "remove_track"]
    items = [
        ChangesetItem(id=f"undo-{op}", op=op, rationale="Undo.", status="pending")  # type: ignore[arg-type]
        for op in ops
    ]
    validated = validate_changeset(_dumped(items))
    assert [item.op for item in validated.items] == ops
