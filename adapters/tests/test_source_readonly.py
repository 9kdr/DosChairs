"""Prove that adapter write and export paths never overwrite source media.

Addresses Chair issue #141:
- Fixture source files with known hashes run through every adapter write/export round-trip.
- Assert source bytes and hashes unchanged after every run.
- Suite fails if any source byte changes.
- Fail closed: any new adapter or write path without coverage fails the suite until added.
- Grade (#17) and macro (#65) referenced assets are included.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import types
from pathlib import Path
from typing import Any

import chair_kdenlive
import chair_otio
import chair_resolve
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MEDIA_DIR = REPO_ROOT / "fixtures" / "media"
HASHES_FILE = MEDIA_DIR / "hashes.json"

COVERED_ADAPTERS: frozenset[str] = frozenset({"kdenlive", "otio", "resolve"})
COVERED_WRITE_FUNCTIONS: frozenset[str] = frozenset(
    {
        "chair_kdenlive.kdenlive_from_timeline",
        "chair_otio.otio_from_timeline",
        "chair_resolve.plan_from_timeline",
        "chair_resolve.write_timeline",
    }
)


def _compute_hashes() -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(MEDIA_DIR.glob("*"))
        if path.is_file() and path.name != "hashes.json"
    }


def assert_source_media_unchanged() -> None:
    current = _compute_hashes()
    recorded = json.loads(HASHES_FILE.read_text(encoding="utf-8"))
    assert current == recorded, f"Source media hash mismatch: {current} != {recorded}"


def _sample_timeline() -> dict[str, Any]:
    return {
        "schemaVersion": "0.1.0",
        "id": "tl-source-readonly-proof",
        "name": "Source Readonly Proof",
        "rate": {"num": 24, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "id": "v1-1",
                        "name": "Interview",
                        "mediaRef": str(MEDIA_DIR / "interview.mov"),
                        "sourceRange": {
                            "start": {"value": 0, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                        "timelineRange": {
                            "start": {"value": 0, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                        "effects": [
                            {
                                "id": "fx-grade",
                                "presetName": "Warm grade",
                                "params": {
                                    "compPath": str(MEDIA_DIR / "grade.comp"),
                                    "reference": str(MEDIA_DIR / "reference_grade.png"),
                                },
                            },
                            {
                                "id": "fx-glow",
                                "presetName": "Chair Glow",
                                "params": {"compPath": str(MEDIA_DIR / "glow.comp")},
                            },
                        ],
                    }
                ],
            },
            {
                "id": "a1",
                "kind": "audio",
                "name": "A1",
                "clips": [
                    {
                        "id": "a1-1",
                        "name": "Audio Track",
                        "mediaRef": str(MEDIA_DIR / "audio.wav"),
                        "sourceRange": {
                            "start": {"value": 0, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                        "timelineRange": {
                            "start": {"value": 0, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                    }
                ],
            },
        ],
        "markers": [
            {"id": "m1", "name": "Hook", "time": {"value": 10, "rate": 24}, "kind": "hook"}
        ],
    }


def _fake_studio():
    log: list[Any] = []
    counts: dict[str, int] = {}

    class FakeTimeline:
        def SetSettings(self, settings: dict) -> bool:
            return True

        def GetTrackCount(self, track_type: str) -> int:
            return counts.get(track_type, 0)

        def AddTrack(self, track_type: str) -> bool:
            counts[track_type] = counts.get(track_type, 0) + 1
            return True

        def SetTrackName(self, track_type: str, index: int, name: str) -> bool:
            return True

        def AddMarker(self, *args: Any, **kwargs: Any) -> bool:
            return True

    fake_tl = FakeTimeline()

    class FakeMediaPool:
        def ImportMedia(self, clips: list) -> list:
            return [object() for _ in clips]

        def CreateEmptyTimeline(self, name: str):
            return fake_tl

        def AppendToTimeline(self, clips: list) -> list:
            return [
                types.SimpleNamespace(ImportFusionComp=lambda p: log.append(p))
                for _ in clips
            ]

    pool = FakeMediaPool()
    project = types.SimpleNamespace(
        GetMediaPool=lambda: pool,
        SetCurrentTimeline=lambda tl: True,
    )
    return types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )


def test_fixture_source_files_exist_with_known_hashes() -> None:
    assert_source_media_unchanged()


def test_kdenlive_write_roundtrip_never_overwrites_source(tmp_path: Path) -> None:
    tl = _sample_timeline()
    assert_source_media_unchanged()

    xml_text = chair_kdenlive.kdenlive_from_timeline(tl)
    assert_source_media_unchanged()

    # Roundtrip from string
    reread = chair_kdenlive.timeline_from_kdenlive(xml_text)
    assert reread["id"] == tl["id"]
    assert_source_media_unchanged()

    # Roundtrip via project file on disk
    project_file = tmp_path / "project.kdenlive"
    project_file.write_text(xml_text, encoding="utf-8")
    from_file = chair_kdenlive.timeline_from_kdenlive(str(project_file))
    assert from_file["id"] == tl["id"]
    assert_source_media_unchanged()


def test_otio_export_never_overwrites_source() -> None:
    tl = _sample_timeline()
    assert_source_media_unchanged()

    otio_json = chair_otio.otio_from_timeline(tl)
    assert_source_media_unchanged()

    parsed = json.loads(otio_json)
    assert parsed["OTIO_SCHEMA"] == "Timeline.1"
    assert_source_media_unchanged()


def test_resolve_write_paths_never_overwrite_source() -> None:
    tl = _sample_timeline()
    assert_source_media_unchanged()

    plan = chair_resolve.plan_from_timeline(tl)
    assert plan["timeline_name"] == tl["name"]
    assert len(plan["clips"]) == 2
    assert len(plan["fusion"]) == 2
    assert_source_media_unchanged()

    summary = chair_resolve.write_timeline(tl, resolve=_fake_studio())
    assert summary["clips"] == 2
    assert summary["fusion"] == 2
    assert_source_media_unchanged()


def test_suite_fails_if_any_source_byte_changes() -> None:
    assert_source_media_unchanged()

    target = MEDIA_DIR / "interview.mov"
    original = target.read_bytes()
    try:
        # Mutate a single byte
        mutated = bytearray(original)
        mutated[0] ^= 0xFF
        target.write_bytes(bytes(mutated))

        with pytest.raises(AssertionError, match="Source media hash mismatch"):
            assert_source_media_unchanged()
    finally:
        target.write_bytes(original)

    assert_source_media_unchanged()


def test_fail_closed_on_uncovered_adapter_directory() -> None:
    adapters_dir = REPO_ROOT / "adapters"
    discovered = {
        entry.name
        for entry in adapters_dir.iterdir()
        if entry.is_dir() and entry.name not in {"tests", "__pycache__"}
    }
    uncovered = discovered - COVERED_ADAPTERS
    assert not uncovered, f"New adapter path(s) {uncovered} lack source-readonly proof coverage."


def test_fail_closed_on_uncovered_write_functions() -> None:
    modules = [chair_kdenlive, chair_otio, chair_resolve]
    found_write_funcs: set[str] = set()

    for mod in modules:
        for name, _obj in inspect.getmembers(mod, inspect.isfunction):
            if any(keyword in name for keyword in ("write", "export", "from_timeline")):
                found_write_funcs.add(f"{mod.__name__}.{name}")

    uncovered = found_write_funcs - COVERED_WRITE_FUNCTIONS
    assert not uncovered, f"New write function(s) {uncovered} lack source-readonly proof coverage."
