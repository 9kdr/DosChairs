import json
from typing import Any

import pytest
from chair_otio import otio_from_timeline


def _time(value: int | float, rate: int | float = 24) -> dict[str, int | float]:
    return {"value": value, "rate": rate}


def _range(start: int | float, duration: int | float) -> dict[str, dict[str, int | float]]:
    return {"start": _time(start), "duration": _time(duration)}


def _timeline() -> dict[str, Any]:
    return {
        "schemaVersion": "0.1.0",
        "id": "tl-1",
        "name": "Rough cut",
        "rate": {"num": 24, "den": 1},
        "globalStart": _time(0),
        "storyPlanId": "story-1",
        "styleProfileId": "style-1",
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "id": "v1-1",
                        "name": "Interview",
                        "mediaRef": "/media/interview.mov",
                        "sourceRange": _range(100, 48),
                        "timelineRange": _range(12, 48),
                        "effects": [
                            {
                                "id": "fx-grade",
                                "presetName": "Teal interview",
                                "params": {"strength": "0.8"},
                            }
                        ],
                    },
                    {
                        "id": "v1-2",
                        "name": "Fast",
                        "mediaRef": "/media/interview.mov",
                        "sourceRange": _range(100, 48),
                        "timelineRange": _range(108, 24),
                    },
                    {
                        "id": "v1-3",
                        "name": "Pickup",
                        "sourceRange": _range(0, 12),
                        "timelineRange": _range(132, 12),
                        "metadata": {"sequenceId": "seq-pickup"},
                    },
                ],
            },
            {
                "id": "a1",
                "kind": "audio",
                "name": "A1",
                "clips": [
                    {
                        "id": "a1-1",
                        "name": "Interview",
                        "mediaRef": "/media/interview.mov",
                        "sourceRange": _range(100, 48),
                        "timelineRange": _range(12, 48),
                    }
                ],
            },
            {
                "id": "s1",
                "kind": "subtitle",
                "name": "Captions",
                "clips": [
                    {
                        "id": "s1-1",
                        "name": "Hello",
                        "sourceRange": _range(0, 24),
                        "timelineRange": _range(36, 24),
                    }
                ],
            },
            {"id": "fx", "kind": "effect", "name": "Looks", "clips": []},
        ],
        "markers": [
            {"id": "m10", "name": "Hook", "time": _time(10), "kind": "hook"},
            {
                "id": "m40",
                "name": "Open",
                "time": _time(40),
                "duration": _time(8),
                "kind": "range",
                "comment": "opener",
                "beatId": "beat-2",
            },
        ],
    }


def _export(timeline: dict[str, Any] | None = None) -> dict[str, Any]:
    return json.loads(otio_from_timeline(_timeline() if timeline is None else timeline))


def test_exports_tracks_clips_gaps_and_markers() -> None:
    doc = _export()
    assert doc["OTIO_SCHEMA"] == "Timeline.1"
    assert doc["name"] == "Rough cut"
    assert doc["global_start_time"] == {"OTIO_SCHEMA": "RationalTime.1", "value": 0, "rate": 24}
    assert doc["metadata"]["chair_timeline_id"] == "tl-1"
    assert doc["metadata"]["chair_story_plan_id"] == "story-1"
    assert doc["metadata"]["chair_style_profile_id"] == "style-1"

    tracks = doc["tracks"]["children"]
    assert [(track["kind"], track["metadata"]["chair_kind"]) for track in tracks] == [
        ("Video", "video"),
        ("Audio", "audio"),
        ("Video", "subtitle"),
        ("Video", "effect"),
    ]
    assert tracks[0]["metadata"]["chair_track_id"] == "v1"

    video = tracks[0]["children"]
    assert [child["OTIO_SCHEMA"] for child in video] == [
        "Gap.1",
        "Clip.1",
        "Gap.1",
        "Clip.1",
        "Clip.1",
    ]
    assert video[0]["source_range"]["duration"]["value"] == 12
    assert video[2]["source_range"]["duration"]["value"] == 48

    first = video[1]
    assert first["name"] == "Interview"
    assert first["media_reference"]["OTIO_SCHEMA"] == "ExternalReference.1"
    assert first["media_reference"]["target_url"] == "/media/interview.mov"
    assert first["source_range"]["start_time"] == {
        "OTIO_SCHEMA": "RationalTime.1",
        "value": 100,
        "rate": 24,
    }
    assert first["metadata"]["chair_clip_id"] == "v1-1"
    assert first["effects"] == [
        {
            "OTIO_SCHEMA": "Effect.1",
            "name": "fx-grade",
            "effect_name": "Teal interview",
            "metadata": {"chair_params": {"strength": "0.8"}},
        }
    ]

    fast = video[3]
    assert fast["effects"] == [
        {
            "OTIO_SCHEMA": "LinearTimeWarp.1",
            "name": "speed",
            "effect_name": "LinearTimeWarp",
            "time_scalar": 2.0,
            "metadata": {},
        }
    ]

    nested = video[4]
    assert nested["media_reference"]["OTIO_SCHEMA"] == "MissingReference.1"
    assert nested["metadata"]["chair_metadata"] == {"sequenceId": "seq-pickup"}

    caption = tracks[2]["children"][1]
    assert caption["name"] == "Hello"
    assert caption["media_reference"]["OTIO_SCHEMA"] == "MissingReference.1"

    assert tracks[3]["children"] == []

    markers = doc["tracks"]["markers"]
    assert "markers" not in doc
    assert [marker["OTIO_SCHEMA"] for marker in markers] == ["Marker.2", "Marker.2"]
    assert [marker["color"] for marker in markers] == ["YELLOW", "PURPLE"]
    assert markers[0]["marked_range"]["start_time"]["value"] == 10
    assert markers[1]["marked_range"]["duration"]["value"] == 8
    assert markers[1]["comment"] == "opener"
    assert markers[1]["metadata"] == {
        "chair_marker_id": "m40",
        "chair_kind": "range",
        "chair_beatid": "beat-2",
    }


def test_disabled_effect_is_honored_and_fractional_rate_stays_exact() -> None:
    timeline = _timeline()
    timeline["rate"] = {"num": 30000, "den": 1001}
    clip = timeline["tracks"][0]["clips"][0]
    clip["effects"][0]["enabled"] = False
    doc = json.loads(otio_from_timeline(timeline))
    assert doc["tracks"]["children"][0]["children"][1]["effects"][0]["enabled"] is False
    gap_rate = doc["tracks"]["children"][0]["children"][0]["source_range"]["duration"]["rate"]
    assert gap_rate == 30000 / 1001


def test_unknown_track_kind_is_rejected() -> None:
    timeline = _timeline()
    timeline["tracks"][0]["kind"] = "effectual"
    with pytest.raises(ValueError, match="effectual"):
        otio_from_timeline(timeline)


def test_unknown_marker_kind_is_rejected() -> None:
    timeline = _timeline()
    timeline["markers"][0]["kind"] = "vibe"
    with pytest.raises(ValueError, match="vibe"):
        otio_from_timeline(timeline)


def test_overlapping_clips_are_rejected() -> None:
    timeline = _timeline()
    timeline["tracks"][1]["clips"].append(
        {
            "id": "a1-2",
            "name": "Overlap",
            "mediaRef": "/media/interview.mov",
            "sourceRange": _range(0, 10),
            "timelineRange": _range(20, 10),
        }
    )
    with pytest.raises(ValueError, match="overlaps"):
        otio_from_timeline(timeline)


def test_clip_without_duration_is_rejected() -> None:
    timeline = _timeline()
    timeline["tracks"][0]["clips"][0]["timelineRange"]["duration"]["value"] = 0
    with pytest.raises(ValueError, match="no timeline duration"):
        otio_from_timeline(timeline)
