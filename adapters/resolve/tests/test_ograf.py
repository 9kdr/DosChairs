"""OGraf title install + timeline planning for the Resolve adapter."""

import types
import zipfile

import pytest
from chair_resolve.manifest import MANIFEST
from chair_resolve.ograf import install_ograf, ograf_dir, place_ograf_title, title_stem
from chair_resolve.write import plan_from_timeline, write_timeline


def _manifest(**overrides):
    bundle = {
        "$schema": "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
        "id": "chair-bounce-title",
        "name": "Bouncing title",
        "main": "chair-bounce-title.js",
        "supportsRealTime": False,
        "supportsNonRealTime": True,
    }
    bundle.update(overrides)
    return bundle


def test_ograf_dir_uses_confirmed_linux_path(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    folder = ograf_dir()
    assert str(folder).endswith("Fusion/Templates/Edit/Titles/OGraf")
    assert ".local/share/DaVinciResolve" in str(folder)


def test_title_stem_is_filesafe() -> None:
    assert title_stem("Bounce Title!") == "chair-bounce-title"
    assert "/" not in title_stem("a/b\\c")
    assert title_stem("") == "chair-effect"


def test_install_ograf_writes_scanned_pair(tmp_path) -> None:
    result = install_ograf(_manifest(), "export default X;", dest=tmp_path)
    assert result["title_name"] == "Bouncing title"
    assert result["stem"] == "chair-chair-bounce-title"
    assert result["packed"] is None
    manifest_path, js_path = result["files"]
    assert manifest_path.endswith(".ograf.json")
    assert js_path.endswith(".js")
    import json

    assert json.loads(open(manifest_path, encoding="utf-8").read())["name"] == "Bouncing title"
    assert open(js_path, encoding="utf-8").read() == "export default X;"


def test_install_ograf_rejects_bad_bundles(tmp_path) -> None:
    with pytest.raises(ValueError):
        install_ograf({"id": "x"}, "export default X;", dest=tmp_path)
    with pytest.raises(ValueError):
        install_ograf(_manifest(supportsNonRealTime=False), "export default X;", dest=tmp_path)
    with pytest.raises(ValueError):
        install_ograf(_manifest(), "  ", dest=tmp_path)


def test_install_ograf_packs_dotograf(tmp_path) -> None:
    result = install_ograf(_manifest(), "export default X;", dest=tmp_path, pack=True)
    assert result["packed"] is not None
    assert result["packed"].endswith(".ograf")
    with zipfile.ZipFile(result["packed"]) as archive:
        names = archive.namelist()
    assert f"{result['stem']}.ograf.json" in names
    assert f"{result['stem']}.js" in names


def test_manifest_declares_ograf_support() -> None:
    assert MANIFEST.capabilities.ograf_titles is True
    assert "ografTitles" in MANIFEST.fallbacks
    assert "OGraf" in MANIFEST.fallbacks["ografTitles"]


def _timeline_with_ograf_effect(**params):
    effect = {"id": "fx-title", "presetName": "Bouncing title", "params": params}
    return {
        "schemaVersion": "0.1.0",
        "id": "tl-ograf",
        "name": "OGraf cut",
        "rate": {"num": 24, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "id": "clip-a",
                        "name": "A",
                        "sourceRange": {
                            "start": {"value": 0, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                        "timelineRange": {
                            "start": {"value": 86400, "rate": 24},
                            "duration": {"value": 48, "rate": 24},
                        },
                        "mediaRef": "/media/a.mov",
                        "effects": [effect],
                    }
                ],
            }
        ],
        "markers": [],
    }


def test_plan_ograf_effect_records_title_name() -> None:
    timeline = _timeline_with_ograf_effect(exportTarget="ograf", ografTitle="Bouncing title")
    plan = plan_from_timeline(timeline)
    assert plan["fusion"] == []
    assert plan["skipped"] == []
    assert [(entry["effect_id"], entry["title_name"]) for entry in plan["ograf_titles"]] == [
        ("fx-title", "Bouncing title")
    ]


def test_plan_ograf_effect_defaults_to_preset_name() -> None:
    plan = plan_from_timeline(_timeline_with_ograf_effect(exportTarget="ograf"))
    assert plan["ograf_titles"][0]["title_name"] == "Bouncing title"


def test_place_ograf_title_reports_whether_scripting_knows_it() -> None:
    assert place_ograf_title(object(), "Anything") is False

    class _Raising:
        def InsertFusionTitleIntoTimeline(self, name: str):
            raise RuntimeError("unknown title")

    assert place_ograf_title(_Raising(), "Anything") is False

    class _Placed:
        def InsertFusionTitleIntoTimeline(self, name: str):
            assert name == "Bouncing title"
            return object()

    assert place_ograf_title(_Placed(), "Bouncing title") is True


def _fake_resolve_without_ograf_api(log: list):
    timeline = types.SimpleNamespace(
        SetSettings=lambda settings: True,
        GetTrackCount=lambda kind: 0,
        AddTrack=lambda kind: True,
        SetTrackName=lambda kind, index, name: True,
        AddMarker=lambda *args: True,
    )
    def _append(clips: list):
        return [types.SimpleNamespace(ImportFusionComp=lambda path: None) for _ in clips]

    pool = types.SimpleNamespace(
        ImportMedia=lambda clips: [object() for _ in clips],
        CreateEmptyTimeline=lambda name: timeline,
        AppendToTimeline=_append,
    )
    project = types.SimpleNamespace(
        GetMediaPool=lambda: pool,
        SetCurrentTimeline=lambda timeline: True,
    )
    return types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )


def test_write_ograf_falls_back_to_drag_by_hand() -> None:
    timeline = _timeline_with_ograf_effect(exportTarget="ograf", ografTitle="Bouncing title")
    summary = write_timeline(timeline, resolve=_fake_resolve_without_ograf_api([]))
    assert summary["ograf"] == 1
    assert summary["skipped"] == 1
    plan = plan_from_timeline(timeline)
    assert plan["ograf_titles"][0]["title_name"] == "Bouncing title"


def test_ograf_fallback_names_the_drag_path() -> None:
    from chair_resolve.write import _write_ograf_title

    attempted: list = []

    class _UnknownTitle:
        def InsertFusionTitleIntoTimeline(self, name: str):
            attempted.append(name)
            return None

    plan: dict = {"skipped": []}
    _write_ograf_title(
        {"title_name": "Bouncing title", "effect_id": "fx-title"},
        _UnknownTitle(),
        plan,
        MANIFEST,
    )
    assert attempted == ["Bouncing title"]
    assert len(plan["skipped"]) == 1
    reason = plan["skipped"][0]["reason"]
    assert "Bouncing title" in reason
    assert "Effects > Titles > OGraf" in reason


def test_write_ograf_install_failure_is_reported() -> None:
    bad = _manifest()
    del bad["supportsNonRealTime"]
    timeline = _timeline_with_ograf_effect(
        exportTarget="ograf",
        ografTitle="Bouncing title",
        ografManifest=bad,
        ografJs="export default X;",
    )
    summary = write_timeline(timeline, resolve=_fake_resolve_without_ograf_api([]))
    assert summary["ograf"] == 1
    assert summary["skipped"] == 1
