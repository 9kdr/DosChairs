import json
from pathlib import Path

import pytest
from chair_kdenlive import kdenlive_from_timeline, timeline_from_kdenlive

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "schemas" / "timeline.schema.json").read_text())

ACTIVE = "{11111111-2222-3333-4444-555555555555}"
NESTED = "{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}"

# The nested sequence is first in the file so a reader that takes the first
# tractor would keep the wrong timeline. Guides use Kdenlive's JSON shape.
PROJECT = f"""<?xml version='1.0' encoding='utf-8'?>
<mlt LC_NUMERIC="C" version="7.28.0" title="Rough cut" producer="main_bin">
  <profile frame_rate_num="24" frame_rate_den="1" width="1920" height="1080"
           progressive="1" sample_aspect_num="1" sample_aspect_den="1"
           display_aspect_num="16" display_aspect_den="9" colorspace="709"/>
  <producer id="black_track">
    <property name="resource">black</property>
    <property name="mlt_service">color</property>
  </producer>
  <producer id="unused0">
    <property name="resource">/media/unused.mov</property>
    <property name="mlt_service">avformat</property>
    <property name="kdenlive:clipname">Unused</property>
  </producer>
  <producer id="inside0">
    <property name="resource">/media/inside.mov</property>
    <property name="mlt_service">avformat</property>
    <property name="kdenlive:clipname">Inside</property>
  </producer>
  <playlist id="other_pl">
    <entry producer="inside0" in="0" out="11"/>
  </playlist>
  <playlist id="other_pl_b"/>
  <tractor id="other_track">
    <property name="kdenlive:track_name">Video 1</property>
    <track producer="other_pl" hide="audio"/>
    <track producer="other_pl_b" hide="audio"/>
  </tractor>
  <tractor id="{NESTED}">
    <property name="kdenlive:uuid">{NESTED}</property>
    <property name="kdenlive:clipname">Pickup</property>
    <property name="kdenlive:sequenceproperties.guides">[
      {{"pos": 1, "comment": "Nope", "type": 0, "duration": 0}}
    ]</property>
    <track producer="black_track"/>
    <track producer="other_track"/>
  </tractor>
  <chain id="chain_interview">
    <property name="resource">/media/interview.mov</property>
    <property name="mlt_service">avformat-novalidate</property>
    <property name="kdenlive:clipname">Interview</property>
  </chain>
  <chain id="chain_broll">
    <property name="resource">/media/broll.mov</property>
    <property name="mlt_service">avformat</property>
    <property name="kdenlive:clipname">B-roll</property>
  </chain>
  <producer id="warp0">
    <property name="mlt_service">timewarp</property>
    <property name="warp_speed">2</property>
    <property name="resource">2:/media/interview.mov</property>
    <property name="kdenlive:clipname">Fast</property>
  </producer>
  <producer id="hello0">
    <property name="mlt_service">qtext</property>
    <property name="kdenlive:clipname">Hello</property>
  </producer>
  <playlist id="a1_pl">
    <blank length="12"/>
    <entry producer="chain_interview" in="100" out="147"/>
  </playlist>
  <playlist id="a1_pl_b"/>
  <tractor id="track_a1">
    <property name="kdenlive:audio_track">1</property>
    <property name="kdenlive:track_name">Audio 1</property>
    <track producer="a1_pl" hide="video"/>
    <track producer="a1_pl_b" hide="video"/>
  </tractor>
  <playlist id="a2_pl"/>
  <playlist id="a2_pl_b"/>
  <tractor id="track_a2">
    <property name="kdenlive:track_name">Audio 2</property>
    <track producer="a2_pl" hide="video"/>
    <track producer="a2_pl_b" hide="video"/>
  </tractor>
  <playlist id="v1_pl">
    <blank length="12"/>
    <entry producer="chain_interview" in="100" out="147">
      <filter id="filter-brightness">
        <property name="mlt_service">brightness</property>
        <property name="kdenlive_id">brightness</property>
        <property name="level">00:00:00.000=0;00:00:01.000=1</property>
      </filter>
    </entry>
    <blank length="24"/>
    <entry producer="chain_broll" in="0" out="23"/>
    <entry producer="warp0" in="50" out="73"/>
    <entry producer="{NESTED}" in="0" out="11"/>
  </playlist>
  <playlist id="v1_pl_b"/>
  <tractor id="track_v1">
    <property name="kdenlive:track_name">Video 1</property>
    <track producer="v1_pl" hide="audio"/>
    <track producer="v1_pl_b" hide="audio"/>
  </tractor>
  <playlist id="s1_pl">
    <blank length="36"/>
    <entry producer="hello0" in="0" out="23"/>
  </playlist>
  <playlist id="s1_pl_b"/>
  <tractor id="track_s1">
    <property name="kdenlive:subtitle_track">1</property>
    <property name="kdenlive:track_name">Captions</property>
    <track producer="s1_pl"/>
    <track producer="s1_pl_b"/>
  </tractor>
  <tractor id="{ACTIVE}">
    <property name="kdenlive:uuid">{ACTIVE}</property>
    <property name="kdenlive:clipname">Rough cut</property>
    <property name="kdenlive:sequenceproperties.guides">[
      {{"comment": "Hook", "duration": 0, "pos": 10, "type": 0}},
      {{"comment": "Open", "duration": 8, "pos": 40, "type": 2}},
      {{"comment": "Room tone", "duration": 0, "pos": 90, "type": 2}}
    ]</property>
    <track producer="black_track"/>
    <track producer="track_a1"/>
    <track producer="track_a2"/>
    <track producer="track_v1"/>
    <track producer="track_s1"/>
  </tractor>
  <playlist id="main_bin">
    <property name="kdenlive:docproperties.activetimeline">{ACTIVE}</property>
    <property name="xml_retain">1</property>
    <entry producer="unused0" in="0" out="10"/>
    <entry producer="{ACTIVE}" in="0" out="0"/>
  </playlist>
  <tractor id="project">
    <property name="kdenlive:projectTractor">1</property>
    <track producer="{ACTIVE}"/>
  </tractor>
</mlt>
"""


def _validate(instance, schema, defs):
    if "$ref" in schema:
        _validate(instance, defs[schema["$ref"].rsplit("/", 1)[-1]], defs)
        return
    if "const" in schema:
        assert instance == schema["const"]
    if "enum" in schema:
        assert instance in schema["enum"]
    expected = schema.get("type")
    if expected == "object":
        assert isinstance(instance, dict)
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            assert set(instance) <= set(props)
        for key in schema.get("required", []):
            assert key in instance
        for key, value in instance.items():
            if key in props:
                _validate(value, props[key], defs)
    elif expected == "array":
        assert isinstance(instance, list)
        for item in instance:
            _validate(item, schema["items"], defs)
    elif expected == "string":
        assert isinstance(instance, str)
        if "minLength" in schema:
            assert len(instance) >= schema["minLength"]
    elif expected == "integer":
        assert type(instance) is int
        if "minimum" in schema:
            assert instance >= schema["minimum"]
    elif expected == "number":
        assert type(instance) in (int, float)
        if "exclusiveMinimum" in schema:
            assert instance > schema["exclusiveMinimum"]
    elif expected == "boolean":
        assert type(instance) is bool


def _assert_schema(timeline: dict) -> None:
    _validate(timeline, SCHEMA, SCHEMA["$defs"])


def test_reads_project_without_dropping_tracks_clips_or_markers(tmp_path: Path) -> None:
    timeline = timeline_from_kdenlive(PROJECT)
    assert timeline["id"] == ACTIVE
    assert timeline["name"] == "Rough cut"
    assert timeline["rate"] == {"num": 24, "den": 1}
    listed = [
        (track["id"], track["kind"], track["name"], len(track["clips"]))
        for track in timeline["tracks"]
    ]
    assert listed == [
        ("a1", "audio", "Audio 1", 1),
        ("a2", "audio", "Audio 2", 0),
        ("v1", "video", "Video 1", 4),
        ("s1", "subtitle", "Captions", 1),
    ]

    audio = timeline["tracks"][0]["clips"][0]
    assert audio["id"] == "a1-1"
    assert audio["name"] == "Interview"
    assert audio["mediaRef"] == "/media/interview.mov"
    assert audio["timelineRange"]["start"]["value"] == 12
    assert audio["sourceRange"]["duration"]["value"] == 48

    video = timeline["tracks"][2]["clips"]
    assert [clip["name"] for clip in video] == ["Interview", "B-roll", "Fast", "Pickup"]
    assert [clip["id"] for clip in video] == ["v1-1", "v1-2", "v1-3", "v1-4"]
    assert video[0]["sourceRange"]["start"]["value"] == 100
    assert video[0]["timelineRange"]["start"]["value"] == 12
    assert video[1]["timelineRange"]["start"]["value"] == 84
    assert video[1]["mediaRef"] == "/media/broll.mov"
    assert video[2]["mediaRef"] == "/media/interview.mov"
    assert video[2]["sourceRange"] == {
        "start": {"value": 100, "rate": 24},
        "duration": {"value": 48, "rate": 24},
    }
    assert video[2]["timelineRange"]["duration"]["value"] == 24
    assert video[2]["timelineRange"]["start"]["value"] == 108
    assert video[3]["metadata"] == {"sequenceId": NESTED}
    assert "mediaRef" not in video[3]
    assert video[0]["effects"] == [
        {
            "id": "filter-brightness",
            "presetName": "brightness",
            "params": {"level": "00:00:00.000=0;00:00:01.000=1"},
        }
    ]

    caption = timeline["tracks"][3]["clips"][0]
    assert caption["name"] == "Hello"
    assert caption["timelineRange"]["start"]["value"] == 36
    assert "mediaRef" not in caption

    assert timeline["markers"] == [
        {"id": "m10", "name": "Hook", "time": {"value": 10, "rate": 24}, "kind": "hook"},
        {
            "id": "m40",
            "name": "Open",
            "time": {"value": 40, "rate": 24},
            "duration": {"value": 8, "rate": 24},
            "kind": "range",
        },
        {"id": "m90", "name": "Room tone", "time": {"value": 90, "rate": 24}, "kind": "user"},
    ]
    names = [clip["name"] for track in timeline["tracks"] for clip in track["clips"]]
    assert "Inside" not in names
    assert "Unused" not in names
    assert "/media/unused.mov" not in json.dumps(timeline)
    assert "Nope" not in [marker["name"] for marker in timeline["markers"]]
    _assert_schema(timeline)

    assert timeline_from_kdenlive(kdenlive_from_timeline(timeline)) == timeline
    project = tmp_path / "cut.kdenlive"
    project.write_text(PROJECT, encoding="utf-8")
    assert timeline_from_kdenlive(str(project))["id"] == ACTIVE


def test_round_trip_keeps_marker_kind_comment_and_effect_track() -> None:
    timeline = timeline_from_kdenlive(PROJECT)
    timeline["storyPlanId"] = "story-1"
    timeline["styleProfileId"] = "style-1"
    timeline["globalStart"] = {"value": 0, "rate": 24}
    timeline["markers"][1]["kind"] = "beat"
    timeline["markers"][1]["comment"] = "opener"
    timeline["tracks"][2]["clips"][0]["effects"][0]["enabled"] = False
    timeline["tracks"].append({"id": "fx", "kind": "effect", "name": "Looks", "clips": []})
    again = timeline_from_kdenlive(kdenlive_from_timeline(timeline))
    assert again == timeline
    _assert_schema(again)


def test_clock_time_uses_the_profile_frame_rate() -> None:
    timeline = timeline_from_kdenlive(
        """
        <mlt producer="main_bin">
          <profile frame_rate_num="25" frame_rate_den="1" width="1920" height="1080"/>
          <chain id="shot">
            <property name="resource">/media/shot.mov</property>
            <property name="kdenlive:clipname">Shot</property>
          </chain>
          <playlist id="v1">
            <entry producer="shot" in="00:00:01.000" out="00:00:01.960"/>
          </playlist>
          <tractor id="seq">
            <property name="kdenlive:uuid">clock</property>
            <property name="kdenlive:clipname">Clock</property>
            <track producer="v1"/>
          </tractor>
        </mlt>
        """
    )
    clip = timeline["tracks"][0]["clips"][0]
    assert timeline["rate"] == {"num": 25, "den": 1}
    assert clip["sourceRange"]["start"]["value"] == 25
    assert clip["sourceRange"]["duration"]["value"] == 25
    assert clip["timelineRange"]["start"]["value"] == 0


def test_fractional_frame_rate_stays_exact() -> None:
    timeline = timeline_from_kdenlive(
        """
        <mlt>
          <profile frame_rate_num="30000" frame_rate_den="1001" width="1920" height="1080"/>
          <chain id="shot">
            <property name="resource">/media/shot.mov</property>
          </chain>
          <playlist id="v1">
            <entry producer="shot" in="0" out="9"/>
          </playlist>
          <tractor id="seq">
            <property name="kdenlive:uuid">ntsc</property>
            <property name="kdenlive:sequenceproperties.guides">[]</property>
            <track producer="v1"/>
          </tractor>
        </mlt>
        """
    )
    assert timeline["rate"] == {"num": 30000, "den": 1001}
    assert timeline["tracks"][0]["clips"][0]["timelineRange"]["duration"]["rate"] == 30000 / 1001
    assert timeline_from_kdenlive(kdenlive_from_timeline(timeline)) == timeline


def test_missing_frame_rate_is_rejected() -> None:
    with pytest.raises(ValueError, match="frame rate"):
        timeline_from_kdenlive(
            """
            <mlt><profile width="1920" height="1080"/>
              <tractor id="seq"><track producer="missing"/></tractor>
            </mlt>
            """
        )


def test_unknown_track_kind_is_rejected() -> None:
    with pytest.raises(ValueError, match="effectual"):
        kdenlive_from_timeline(
            {
                "schemaVersion": "0.1.0",
                "id": "tl",
                "name": "Cut",
                "rate": {"num": 24, "den": 1},
                "tracks": [{"id": "e1", "kind": "effectual", "name": "FX", "clips": []}],
                "markers": [],
            }
        )
