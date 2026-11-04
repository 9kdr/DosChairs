"""POST /projects/open puts the editor on the project first (#314)."""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent import open_project as opener
from chair_agent.__main__ import Handler
from chair_agent.jobs import JobController


def _resolve_already(name: str) -> dict:
    return {"opened": True, "alreadyCurrent": True, "project": name}


def test_open_in_editor_resolve_confirms() -> None:
    body = opener.open_in_editor(
        "resolve:chair-captest",
        "Chair Captest",
        resolve_open=_resolve_already,
    )
    assert body == {
        "project_id": "resolve:chair-captest",
        "editor": "resolve",
        "opened": True,
        "alreadyCurrent": True,
        "project": "Chair Captest",
    }


def test_open_in_editor_resolve_needs_name() -> None:
    with pytest.raises(opener.OpenProjectError, match="needs the Resolve"):
        opener.open_in_editor(
            "resolve:chair-captest", None, resolve_open=_resolve_already
        )


def test_open_in_editor_otio_refuses() -> None:
    with pytest.raises(opener.OpenProjectError, match="no editor app"):
        opener.open_in_editor("otio:roundtrip", "Roundtrip")


def test_open_in_editor_bad_id_refuses() -> None:
    with pytest.raises(opener.OpenProjectError, match="project_id"):
        opener.open_in_editor("nope", "Nope")


def test_open_in_editor_kdenlive_missing_file_is_unknown(
    tmp_path: Path,
) -> None:
    with pytest.raises(opener.ProjectUnknownError, match="no longer on disk"):
        opener.open_in_editor(
            "kdenlive:trailer",
            "Trailer",
            kdenlive_open=lambda path: {"opened": True},
            root=tmp_path,
        )


def test_open_in_editor_kdenlive_launches_on_file(tmp_path: Path) -> None:
    seen: list[Path] = []
    (tmp_path / "Trailer.kdenlive").write_text("project")

    def fake_open(path: Path) -> dict:
        seen.append(path)
        return {"opened": True, "alreadyCurrent": False, "project": "Trailer"}

    body = opener.open_in_editor(
        "kdenlive:trailer", "Trailer", kdenlive_open=fake_open, root=tmp_path
    )
    assert seen == [tmp_path / "Trailer.kdenlive"]
    assert body["opened"] is True
    assert body["project"] == "Trailer"


def _serve(
    controller: JobController,
) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def _post(base: str, path: str, payload: dict) -> tuple[int, dict]:
    request = Request(
        f"{base}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except Exception as error:  # HTTPError carries the failure body
        body = error.read()  # type: ignore[attr-defined]
        return error.code, json.loads(body)  # type: ignore[attr-defined]


def test_http_open_route_and_health_counters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "chair_agent.open_project._resolve_open", _resolve_already
    )
    controller = JobController(
        tmp_path / "jobs.json", deliver=lambda url, body, headers: None
    )
    server, thread, base = _serve(controller)
    try:
        status, body = _post(
            base,
            "/projects/open",
            {"project_id": "resolve:chair-captest", "name": "Chair Captest"},
        )
        assert status == 200
        assert body["alreadyCurrent"] is True
        status, body = _post(base, "/projects/open", {"project_id": "nope"})
        assert status == 400
        assert body["error"]["code"] == "invalid_open"
        with urlopen(f"{base}/health") as response:
            health = json.load(response)
        assert health["open_project"]["opened"] >= 1
        assert health["open_project"]["last_editor"] == "resolve"
        assert "project_id" in health["open_project"]["last_error"]
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
