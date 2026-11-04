"""Piece undo route: POST /effects/rig/revert (#290)."""

import json
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen

import pytest
from chair_agent.__main__ import Handler


class _Item:
    """A clip with two comp versions, neither framed, like a fresh build."""

    def __init__(self) -> None:
        self.names = ["Comp 1", "Comp 2"]
        self.loaded: list = []
        self.deleted: list = []

    def GetFusionCompNameList(self):
        return list(self.names)

    def GetFusionCompByName(self, name):
        return None

    def LoadFusionCompByName(self, name):
        self.loaded.append(name)
        return True

    def DeleteFusionCompByName(self, name):
        self.deleted.append(name)
        self.names = [known for known in self.names if known != name]
        return True


def _install_resolve(monkeypatch: pytest.MonkeyPatch, project) -> None:
    import sys as _sys
    import types as _types

    manager = _types.SimpleNamespace(GetCurrentProject=lambda: project)
    bmd = _types.ModuleType("DaVinciResolveScript")
    bmd.scriptapp = lambda name: _types.SimpleNamespace(
        GetProjectManager=lambda: manager)
    monkeypatch.setitem(_sys.modules, "DaVinciResolveScript", bmd)


def _project(item) -> object:
    import types as _types

    timeline = _types.SimpleNamespace(
        GetName=lambda: "demo-check",
        GetItemListInTrack=lambda track_type, index: [item],
    )
    return _types.SimpleNamespace(
        GetName=lambda: "Chair Captest",
        GetCurrentTimeline=lambda: timeline,
    )


def _serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop(server, thread) -> None:
    server.shutdown()
    thread.join(timeout=2)
    server.server_close()


def _post(port: int, path: str, payload: dict):
    from urllib.error import HTTPError

    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def test_revert_removes_the_added_version(monkeypatch: pytest.MonkeyPatch) -> None:
    item = _Item()
    _install_resolve(monkeypatch, _project(item))
    server, thread = _serve()
    try:
        port = server.server_address[1]
        status, body = _post(port, "/effects/rig/revert", {
            "op": {"comp_name": "Comp 2", "prev_comp_name": "Comp 1",
                   "undo": {"prev_comp_name": "Comp 1"}},
            "project": "Chair Captest",
        })
    finally:
        _stop(server, thread)
    assert status == 200
    assert body == {"comp_name": "Comp 1", "project": "Chair Captest",
                    "timeline": "demo-check"}
    assert item.loaded == []  # no framed comp: never loads (#290)
    assert item.deleted == ["Comp 2"]


def test_revert_needs_an_op_or_a_tocomp(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_resolve(monkeypatch, _project(_Item()))
    server, thread = _serve()
    try:
        port = server.server_address[1]
        status, body = _post(port, "/effects/rig/revert", {"project": "Chair Captest"})
    finally:
        _stop(server, thread)
    assert status == 400
    assert body["error"]["code"] == "invalid_rig"


def test_revert_refuses_another_project(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_resolve(monkeypatch, _project(_Item()))
    server, thread = _serve()
    try:
        port = server.server_address[1]
        status, body = _post(port, "/effects/rig/revert", {
            "toComp": "Comp 1", "project": "Chair Spike"})
    finally:
        _stop(server, thread)
    assert status == 502
    assert body["error"]["code"] == "resolve_failed"
