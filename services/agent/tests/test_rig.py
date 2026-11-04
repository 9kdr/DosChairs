"""Apply-piece route: baked keys land as a new comp, never touching the old one (#273).

The brief-to-Rig model route is gone: a cursor brief goes through the piece
path (POST /effects/modules/generate, kind rig) like every other piece.
"""

import json
import sys
import threading
import types
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent.__main__ import Handler


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(Path(__file__).resolve().parents[3]))
    return tmp_path


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


def test_http_apply_lands_a_new_comp_with_undo(isolated, monkeypatch) -> None:
    item = _FakeItem()
    _install_resolve_stubs(monkeypatch, item)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for path in ("/effects/rig/apply", "/effects/apply"):
            apply = Request(
                f"http://127.0.0.1:{port}{path}",
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
