"""Linux auto-bake: shader layers naming a module bake to PNGs for the Loader path (#308)."""

import sys
import types
from pathlib import Path

import pytest
from chair_agent import piece_bake
from chair_agent.piece_bake import BakeError


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("CHAIR_ROOT", str(Path(__file__).resolve().parents[3]))
    piece_bake.reset_status()
    return tmp_path


def _spec(**overrides):
    base = {
        "schemaVersion": "0.1.0",
        "id": "fx-bake",
        "name": "Baked piece",
        "durationSec": 2.0,
        "fps": 30,
        "width": 640,
        "height": 360,
        "layers": [],
    }
    base.update(overrides)
    return base


def test_bakeable_layers_picks_module_shaders_only(isolated) -> None:
    spec = _spec(layers=[
        {"id": "web", "type": "shader",
         "params": {"module": "liquid-boxes", "speed": 0.8}},
        {"id": "native", "type": "shader", "params": {"look": "dither"}},
        {"id": "ball", "type": "shape", "params": {"kind": "ellipse"}},
        {"id": "plain", "type": "shader", "params": {}},
    ])
    plans = piece_bake.bakeable_layers(spec, None)
    assert [plan["layer_id"] for plan in plans] == ["web"]
    assert plans[0]["module"] == "liquid-boxes"
    assert plans[0]["props"] == {"speed": 0.8}
    assert plans[0]["keyframes"] is None


def test_bakeable_layers_skips_caller_sequences_and_sorts_curves(isolated) -> None:
    spec = _spec(layers=[
        {"id": "web", "type": "shader", "params": {"module": "mesh-gradient"},
         "curves": {"speed": {"keyframes": [
             {"time": 1.5, "value": 0.9}, {"time": 0, "value": 0.2},
         ]}}},
    ])
    assert piece_bake.bakeable_layers(
        spec, {"web": {"files": ["a.png"]}}) == []
    plans = piece_bake.bakeable_layers(spec, None)
    assert plans[0]["keyframes"] == {"speed": [[0.0, 0.2], [1.5, 0.9]]}


def test_resolve_entry_library_and_unknown(isolated) -> None:
    entry = piece_bake.resolve_entry("liquid-boxes")
    assert entry.name == "liquid-boxes.tsx"
    assert entry.is_file()
    with pytest.raises(BakeError) as caught:
        piece_bake.resolve_entry("no-such-piece")
    assert caught.value.status == 404


def test_ograf_unavailable_on_linux(isolated) -> None:
    assert piece_bake.ograf_unavailable() is True


def test_ograf_available_on_mac_unless_manifest_says_no(
    isolated, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import chair_resolve.manifest as manifest_module

    real = manifest_module.MANIFEST
    monkeypatch.setattr(sys, "platform", "darwin")
    assert piece_bake.ograf_unavailable() is False
    denied = real.model_copy(update={
        "capabilities": real.capabilities.model_copy(
            update={"ograf_titles": False}),
    })
    monkeypatch.setattr(manifest_module, "MANIFEST", denied)
    assert piece_bake.ograf_unavailable() is True


def test_bake_for_apply_merges_sequences_and_notes(
    isolated, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    def fake_bake(module_id, **kwargs):
        calls.append((module_id, kwargs))
        return {"files": ["f1.png", "f2.png"], "frames": 2}

    monkeypatch.setattr(piece_bake, "bake_module", fake_bake)
    spec = _spec(layers=[
        {"id": "web", "type": "shader",
         "params": {"module": "liquid-boxes", "speed": 0.8}},
    ])
    merged, notes = piece_bake.bake_for_apply(spec, None)
    assert merged == {"web": {"files": ["f1.png", "f2.png"]}}
    assert notes == ["Baked for Linux; edit in Chair to change it"]
    assert calls[0][0] == "liquid-boxes"
    assert calls[0][1]["width"] == 640
    assert calls[0][1]["props"] == {"speed": 0.8}


def test_bake_module_reuses_cached_frames(
    isolated, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        piece_bake, "resolve_entry", lambda module_id: Path("/tmp/x.tsx"))
    out_dir = piece_bake.bake_cache_dir() / piece_bake._bake_key(
        "liquid-boxes", 640, 360, 30, 0.1, {}, None)
    out_dir.mkdir(parents=True)
    frames = max(1, round(0.1 * 30))
    for index in range(frames):
        (out_dir / f"frame-{index + 1:06d}.png").write_bytes(b"png")
    outcome = piece_bake.bake_module(
        "liquid-boxes", width=640, height=360, fps=30, duration_sec=0.1)
    assert outcome["cached"] is True
    assert outcome["frames"] == frames
    assert len(outcome["files"]) == frames


def test_rig_apply_auto_bakes_on_linux(
    isolated, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from chair_agent import __main__ as agent_main

    seen: dict = {}

    def fake_bake_for_apply(spec, sequences):
        seen["spec_id"] = spec.get("id")
        return {"web": {"files": ["f1.png"]}}, [piece_bake.BAKE_NOTE]

    monkeypatch.setattr(piece_bake, "bake_for_apply", fake_bake_for_apply)
    monkeypatch.setattr(
        agent_main, "_resolve_timeline_item",
        lambda *args: (object(), "Chair Captest", "Timeline 1"),
    )
    chair_resolve = types.ModuleType("chair_resolve")

    def fake_add_effect(item, spec, **kwargs):
        seen["sequences"] = kwargs.get("sequences")
        return {
            "effect_id": spec.get("id"),
            "comp_name": "Comp 2",
            "prev_comp_name": "Comp 1",
            "paths": {"web": "baked:Loader"},
            "undo": {"prev_comp_name": "Comp 1"},
        }

    chair_resolve.add_effect = fake_add_effect
    monkeypatch.setitem(sys.modules, "chair_resolve", chair_resolve)
    spec = _spec(layers=[
        {"id": "web", "type": "shader",
         "params": {"module": "liquid-boxes"}},
    ])
    answer = agent_main._rig_apply_body({"spec": spec})
    assert seen["sequences"] == {"web": {"files": ["f1.png"]}}
    assert answer["paths"] == {"web": "baked:Loader"}
    assert answer["notes"] == "Baked for Linux; edit in Chair to change it"
    assert answer["prev_comp_name"] == "Comp 1"
