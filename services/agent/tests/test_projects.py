import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import pytest
from chair_agent.__main__ import Handler
from chair_agent.jobs import JobController
from chair_agent.projects import detect_projects


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("project")


def test_detect_lists_file_projects_and_open_resolve(tmp_path: Path) -> None:
    _touch(tmp_path / "Trailer.kdenlive")
    _touch(tmp_path / "Roundtrip.OTIO")
    _touch(tmp_path / "notes.txt")

    body = detect_projects(tmp_path, resolve_project="Talking head")

    assert [editor["id"] for editor in body["editors"]] == [
        "resolve",
        "kdenlive",
        "otio",
    ]
    assert {editor["id"]: editor["status"] for editor in body["editors"]} == {
        "resolve": "inProject",
        "kdenlive": "idle",
        "otio": "idle",
    }
    assert body["projects"] == [
        {
            "id": "resolve:talking-head",
            "name": "Talking head",
            "editor": "resolve",
            "edited_at": body["projects"][0]["edited_at"],
            "preview": "Open now",
        },
        {
            "id": "kdenlive:trailer",
            "name": "Trailer",
            "editor": "kdenlive",
            "edited_at": body["projects"][1]["edited_at"],
            "preview": "On disk",
        },
        {
            "id": "otio:roundtrip",
            "name": "Roundtrip",
            "editor": "otio",
            "edited_at": body["projects"][2]["edited_at"],
            "preview": "On disk",
        },
    ]


def test_detect_closed_studio_and_missing_folder_stop_cleanly(tmp_path: Path) -> None:
    body = detect_projects(tmp_path / "absent", resolve_project=None)

    assert {editor["id"]: editor["status"] for editor in body["editors"]} == {
        "resolve": "stopped",
        "kdenlive": "stopped",
        "otio": "stopped",
    }
    assert body["projects"] == []


def _serve(controller: JobController) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def test_http_projects_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _touch(tmp_path / "Shelf.kdenlive")
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(
        "chair_agent.projects.current_resolve_project", lambda: None
    )
    controller = JobController(
        tmp_path / "jobs.json", deliver=lambda url, body, headers: None
    )
    server, thread, base = _serve(controller)
    try:
        with urlopen(f"{base}/projects") as response:
            assert response.status == 200
            body = json.load(response)
        assert {editor["id"]: editor["status"] for editor in body["editors"]} == {
            "resolve": "stopped",
            "kdenlive": "idle",
            "otio": "idle",
        }
        assert [project["id"] for project in body["projects"]] == ["kdenlive:shelf"]
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
