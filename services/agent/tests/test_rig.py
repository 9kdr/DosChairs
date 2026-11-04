"""Mouse rig: brief drafts a Rig, apply lands baked keys as a new comp (#256)."""

import json
import sys
import threading
import types
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent import rig
from chair_agent.__main__ import Handler
from chair_agent.client import Completion
from chair_agent.rig import InvalidRig


def _rig(**overrides):
    base = {
        "inputPath": [
            {"time": 0, "x": 200, "y": 800},
            {"time": 0.5, "x": 960, "y": 540},
            {"time": 0.9, "x": 1200, "y": 500},
        ],
        "stiffness": 90,
        "damping": 8,
        "mass": 1,
        "swing": True,
        "tilt": True,
        "squash": True,
        "overshoot": True,
    }
    base.update(overrides)
    return base


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(Path(__file__).resolve().parents[3]))
    rig._STATUS.update({
        "generated": 0, "repairs": 0,
        "last_latency_ms": None, "last_error": None,
    })
    return tmp_path


class FakeClient:
    """Queued execute completion texts."""

    def __init__(self, execute=()):
        self.execute_texts = list(execute)
        self.execute_calls = 0
        self.last_messages = None

    def execute(self, messages):
        self.execute_calls += 1
        self.last_messages = messages
        return Completion(model="muse-spark-1", text=self.execute_texts.pop(0))


def test_generate_validates_and_returns_rig(isolated) -> None:
    client = FakeClient(execute=[json.dumps(_rig())])
    out = rig.generate_rig(
        "cursor swings in with momentum, overshoots, settles, then bounces",
        width=1920, height=1080, fps=30, duration_sec=3.0, client=client,
    )
    assert out["rig"]["stiffness"] == 90
    assert len(out["rig"]["inputPath"]) == 3
    assert "Muse Spark" in out["notes"]
    assert client.execute_calls == 1
    developer = next(m.content for m in client.last_messages if m.role == "developer")
    assert "inputPath" in developer and "overshoot" in developer
    assert "1920x1080" in developer
    snapshot = rig.status_snapshot()
    assert snapshot["generated"] == 1
    assert snapshot["last_error"] is None
    assert isinstance(snapshot["last_latency_ms"], float)


def test_generate_rejects_bad_physics_then_repairs(isolated) -> None:
    bad = _rig(damping="soft")
    client = FakeClient(execute=[json.dumps(bad), json.dumps(_rig())])
    out = rig.generate_rig("swing in", width=1280, height=720, fps=30,
                           duration_sec=2.0, client=client)
    assert client.execute_calls == 2
    assert "repaired on retry" in out["notes"]
    assert rig.status_snapshot()["repairs"] == 1

    always_bad = FakeClient(execute=[json.dumps(bad)] * 3)
    with pytest.raises(InvalidRig, match="failed validation 3 times"):
        rig.generate_rig("swing in", width=1280, height=720, fps=30,
                         duration_sec=2.0, client=always_bad)
    assert always_bad.execute_calls == 3


def test_generate_rejects_empty_brief_backwards_time_and_bad_flags(isolated) -> None:
    client = FakeClient(execute=[])
    with pytest.raises(InvalidRig, match="non-empty 'brief'"):
        rig.generate_rig(" ", width=1920, height=1080, fps=30,
                         duration_sec=3.0, client=client)
    with pytest.raises(InvalidRig, match="must not go backwards"):
        rig.validate_rig(_rig(inputPath=[
            {"time": 0.5, "x": 1, "y": 1}, {"time": 0.2, "x": 2, "y": 2}]))
    with pytest.raises(InvalidRig, match="must be a boolean"):
        rig.validate_rig(_rig(squash="yes"))
    with pytest.raises(InvalidRig, match="positive number"):
        rig.validate_rig(_rig(mass=0))


class _FakeItem:
    def __init__(self) -> None:
        self.names = ["Comp 1"]
        self.imported: list[str] = []

    def GetFusionCompNameList(self) -> list[str]:
        return list(self.names)

    def GetCurrentFusionComp(self):
        return None

    def ImportFusionComp(self, path: str):
        self.imported.append(path)
        self.names.append(f"Comp {len(self.names) + 1}")
        return object()

    def LoadFusionCompByName(self, name: str) -> bool:
        return True


def _install_resolve_stubs(monkeypatch: pytest.MonkeyPatch, item: _FakeItem) -> None:
    timeline = types.SimpleNamespace(
        GetName=lambda: "Chair Captest 256",
        GetItemListInTrack=lambda kind, index: [item],
    )
    project = types.SimpleNamespace(
        GetName=lambda: "Chair Captest",
        GetTimelineCount=lambda: 1,
        GetTimelineByIndex=lambda index: timeline,
        GetCurrentTimeline=lambda: timeline,
    )
    manager = types.SimpleNamespace(
        GetProjectByName=lambda name: project,
        GetCurrentProject=lambda: project,
    )
    bmd = types.ModuleType("DaVinciResolveScript")
    bmd.scriptapp = lambda name: types.SimpleNamespace(GetProjectManager=lambda: manager)
    monkeypatch.setitem(sys.modules, "DaVinciResolveScript", bmd)
    import importlib

    real = importlib.import_module("chair_resolve")
    chair_resolve = types.ModuleType("chair_resolve")
    chair_resolve.__dict__.update(real.__dict__)
    chair_resolve.resolve_app = lambda: bmd.scriptapp("Resolve")

    def fake_add_effect(entry, spec, *, cache_dir=None, baked=None,
                        media=None, sequences=None):
        assert baked == {"ball": {"x": [{"time": 0, "value": 1}]}}
        return {
            "effect_id": spec.get("id"),
            "comp_name": "Comp 2",
            "prev_comp_name": "Comp 1",
            "paths": {"ball": "native:Transform"},
            "undo": {"prev_comp_name": "Comp 1"},
        }

    chair_resolve.add_effect = fake_add_effect
    monkeypatch.setitem(sys.modules, "chair_resolve", chair_resolve)


def _spec() -> dict:
    return {
        "schemaVersion": "0.1.0",
        "id": "fx-rig",
        "name": "Rigged title",
        "durationSec": 3.0,
        "fps": 30,
        "width": 1920,
        "height": 1080,
        "layers": [{"id": "ball", "type": "shape",
                    "params": {"kind": "ellipse"}}],
    }


def test_http_rig_generate_and_apply(isolated, monkeypatch) -> None:
    client = FakeClient(execute=[json.dumps(_rig())])
    monkeypatch.setattr("chair_agent.rig._model_client", lambda: client)
    item = _FakeItem()
    _install_resolve_stubs(monkeypatch, item)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        generate = Request(
            f"http://127.0.0.1:{port}/effects/rig/generate",
            data=json.dumps({
                "brief": "cursor swings in with momentum, overshoots, settles",
                "canvas": {"width": 1920, "height": 1080},
                "fps": 30, "durationSec": 3.0,
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(generate) as response:
            created = json.load(response)
        assert len(created["rig"]["inputPath"]) == 3

        apply = Request(
            f"http://127.0.0.1:{port}/effects/rig/apply",
            data=json.dumps({
                "spec": _spec(),
                "baked": {"ball": {"x": [{"time": 0, "value": 1}]}},
                "project": "Chair Captest",
                "timeline": "Chair Captest 256",
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(apply) as response:
            applied = json.load(response)
        assert applied["comp_name"] == "Comp 2"
        assert applied["prev_comp_name"] == "Comp 1"
        assert applied["paths"] == {"ball": "native:Transform"}
        assert applied["keyframes"] == 1
        assert applied["timeline"] == "Chair Captest 256"

        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            health = json.load(response)
        assert health["rig"]["generated"] == 1
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_apply_needs_spec_or_effect(isolated) -> None:
    from chair_agent.__main__ import _rig_apply_body
    from chair_agent.effects import InvalidEffect

    with pytest.raises(InvalidEffect, match="inline 'spec' or an 'effectId'"):
        _rig_apply_body({})
    with pytest.raises(InvalidEffect, match="unknown effect"):
        _rig_apply_body({"effectId": "fx-nope"})
