import json
import runpy
import sys
import types
from pathlib import Path

import pytest
from chair_resolve import read as resolve_read
from chair_resolve.read import (
    ResolveClosedError,
    read_current_timeline,
    resolve_app,
    scripting_module_paths,
    timeline_from_resolve,
)

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "schemas" / "timeline.schema.json").read_text())
CURRENT_TIMELINE = runpy.run_path(str(Path(__file__).with_name("current_timeline.py")))[
    "CURRENT_TIMELINE"
]

EXPECTED = {
    "schemaVersion": "0.1.0",
    "id": "tl-demo-rough",
    "name": "Rough cut",
    "rate": {"num": 24, "den": 1},
    "globalStart": {"value": 86400, "rate": 24},
    "tracks": [
        {
            "id": "v1",
            "kind": "video",
            "name": "V1",
            "clips": [
                {
                    "id": "clip-interview",
                    "name": "Interview",
                    "mediaRef": "/media/interview.mov",
                    "sourceRange": {
                        "start": {"value": 100, "rate": 24},
                        "duration": {"value": 96, "rate": 24},
                    },
                    "timelineRange": {
                        "start": {"value": 86400, "rate": 24},
                        "duration": {"value": 48, "rate": 24},
                    },
                }
            ],
        },
        {
            "id": "a1",
            "kind": "audio",
            "name": "A1",
            "clips": [
                {
                    "id": "clip-interview-audio",
                    "name": "Interview audio",
                    "mediaRef": "/media/interview.mov",
                    "sourceRange": {
                        "start": {"value": 100, "rate": 24},
                        "duration": {"value": 48, "rate": 24},
                    },
                    "timelineRange": {
                        "start": {"value": 86400, "rate": 24},
                        "duration": {"value": 48, "rate": 24},
                    },
                }
            ],
        },
        {
            "id": "s1",
            "kind": "subtitle",
            "name": "Captions",
            "clips": [
                {
                    "id": "sub-hello",
                    "name": "Hello",
                    "sourceRange": {
                        "start": {"value": 0, "rate": 24},
                        "duration": {"value": 24, "rate": 24},
                    },
                    "timelineRange": {
                        "start": {"value": 86412, "rate": 24},
                        "duration": {"value": 24, "rate": 24},
                    },
                }
            ],
        },
    ],
    "markers": [
        {
            "id": "m86410",
            "name": "Hook",
            "time": {"value": 86410, "rate": 24},
            "duration": {"value": 1, "rate": 24},
            "kind": "hook",
        },
        {
            "id": "m86420",
            "name": "Open",
            "time": {"value": 86420, "rate": 24},
            "duration": {"value": 8, "rate": 24},
            "kind": "beat",
            "comment": "opener",
        },
        {
            "id": "m86448",
            "name": "Room tone",
            "time": {"value": 86448, "rate": 24},
            "duration": {"value": 1, "rate": 24},
            "kind": "user",
            "comment": "room tone",
        },
    ],
}


def _validate(instance, schema, defs):
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        _validate(instance, defs[name], defs)
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


def test_fixture_maps_current_timeline() -> None:
    timeline = timeline_from_resolve(CURRENT_TIMELINE)
    assert timeline == EXPECTED
    _assert_schema(timeline)
    dumped = json.dumps(timeline)
    assert "ignore-me" not in dumped
    assert "fusion" not in dumped
    assert "/media/interview.mov" in dumped


def test_marker_kind_matches_only_an_exact_chair_kind() -> None:
    timeline = timeline_from_resolve(
        {
            "name": "Markers",
            "frame_rate": "24",
            "tracks": [],
            "markers": {
                1: {"name": "fix me", "color": "Red", "duration": 1, "note": ""},
                2: {"name": "Fix", "color": "Red", "duration": 1, "note": ""},
            },
        }
    )
    assert [marker["kind"] for marker in timeline["markers"]] == ["user", "fix"]


def test_numeric_frame_rate_from_resolve_setting() -> None:
    """Live Studio GetSetting('timelineFrameRate') returns a float, not a string."""
    timeline = timeline_from_resolve(
        {
            "name": "Live",
            "frame_rate": 24.0,
            "tracks": [],
            "markers": {},
        }
    )
    assert timeline["rate"] == {"num": 24, "den": 1}


def test_fractional_frame_rate_stays_exact() -> None:
    timeline = timeline_from_resolve(
        {
            "name": "NTSC",
            "frame_rate": "24.000",
            "tracks": [],
            "markers": {},
        }
    )
    assert timeline["rate"] == {"num": 24, "den": 1}

    timeline = timeline_from_resolve(
        {
            "name": "NTSC",
            "frame_rate": "23.976",
            "start_frame": 0,
            "tracks": [
                {
                    "track_type": "video",
                    "index": 1,
                    "name": "V1",
                    "items": [
                        {
                            "name": "Shot",
                            "start": 0,
                            "end": 10,
                            "source_start_frame": 0,
                            "source_end_frame": 10,
                            "file_path": "/media/shot.mov",
                        }
                    ],
                }
            ],
            "markers": {},
        }
    )
    assert timeline["rate"] == {"num": 24000, "den": 1001}
    assert timeline["tracks"][0]["clips"][0]["timelineRange"]["duration"]["rate"] == 24000 / 1001
    assert timeline["tracks"][0]["clips"][0]["id"] == "v1-1"
    _assert_schema(timeline)


def test_unknown_frame_rate_is_not_guessed() -> None:
    with pytest.raises(ValueError, match="23.98"):
        timeline_from_resolve({"name": "Bad", "frame_rate": "23.98", "tracks": [], "markers": {}})


def test_missing_unique_id_uses_project_and_timeline_name() -> None:
    timeline = timeline_from_resolve(
        {
            "project_name": "Demo",
            "name": "Rough cut",
            "frame_rate": "25",
            "tracks": [],
            "markers": {},
        }
    )
    assert timeline["id"] == "demo-rough-cut"
    assert timeline["name"] == "Rough cut"


@pytest.mark.parametrize("module", [None, "closed"])
def test_closed_resolve_errors_clearly(monkeypatch: pytest.MonkeyPatch, module: str | None) -> None:
    if module is None:
        monkeypatch.setitem(sys.modules, "DaVinciResolveScript", None)
    else:
        closed = types.ModuleType("DaVinciResolveScript")
        closed.scriptapp = lambda name: None
        monkeypatch.setitem(sys.modules, "DaVinciResolveScript", closed)
    with pytest.raises(ResolveClosedError, match="closed"):
        read_current_timeline()


def test_live_caller_reads_the_open_timeline(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    def scriptapp(name: str):
        seen["name"] = name
        def clip_property(key: str) -> str:
            return "/media/a.mov" if key == "File Path" else ""

        pool = types.SimpleNamespace(GetClipProperty=clip_property)
        item = types.SimpleNamespace(
            GetName=lambda: "Interview",
            GetStart=lambda: 0,
            GetEnd=lambda: 24,
            GetUniqueId=lambda: "clip-1",
            GetMediaPoolItem=lambda: pool,
        )
        timeline = types.SimpleNamespace(
            GetName=lambda: "Cut",
            GetUniqueId=lambda: "tl-1",
            GetStartFrame=lambda: 0,
            GetSetting=lambda key: "24" if key == "timelineFrameRate" else "",
            GetTrackCount=lambda kind: 1 if kind == "video" else 0,
            GetTrackName=lambda kind, index: "V1",
            GetItemListInTrack=lambda kind, index: [item] if kind == "video" else [],
            GetMarkers=lambda: {
                12.0: {
                    "color": "Blue",
                    "duration": 1.0,
                    "note": "",
                    "name": "Mark",
                    "customData": "",
                }
            },
        )
        project = types.SimpleNamespace(
            GetName=lambda: "Demo",
            GetCurrentTimeline=lambda: timeline,
            GetSetting=lambda key: "",
        )
        return types.SimpleNamespace(
            GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
        )

    module = types.ModuleType("DaVinciResolveScript")
    module.scriptapp = scriptapp
    monkeypatch.setitem(sys.modules, "DaVinciResolveScript", module)

    timeline = read_current_timeline()
    assert seen["name"] == "Resolve"
    assert timeline["name"] == "Cut"
    assert timeline["id"] == "tl-1"
    clip = timeline["tracks"][0]["clips"][0]
    assert clip["mediaRef"] == "/media/a.mov"
    assert set(clip) == {"id", "name", "mediaRef", "sourceRange", "timelineRange"}
    assert clip["sourceRange"]["duration"]["value"] == 24
    assert timeline["markers"][0]["kind"] == "user"
    assert timeline["markers"][0]["time"]["value"] == 12
    _assert_schema(timeline)


def test_open_resolve_without_a_timeline_errors_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    module = types.ModuleType("DaVinciResolveScript")
    project = types.SimpleNamespace(GetCurrentTimeline=lambda: None)
    module.scriptapp = lambda name: types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )
    monkeypatch.setitem(sys.modules, "DaVinciResolveScript", module)
    with pytest.raises(ResolveClosedError, match="no current timeline"):
        read_current_timeline()


def test_resolve_app_finds_scripting_without_pythonpath(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Studio scripting resolves from its install location (#196)."""
    (tmp_path / "DaVinciResolveScript.py").write_text(
        'def scriptapp(name):\n    return ("app", name)\n'
    )
    monkeypatch.delitem(sys.modules, "DaVinciResolveScript", raising=False)
    monkeypatch.setattr(sys, "path", [])
    monkeypatch.setattr(resolve_read, "scripting_module_paths", lambda: [str(tmp_path)])
    assert resolve_app() == ("app", "Resolve")


def test_scripting_module_paths_only_lists_installed_dirs() -> None:
    for path in scripting_module_paths():
        assert Path(path).is_dir()
