import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import pytest
from chair_agent.__main__ import Handler
from chair_agent.assets import build_assets
from chair_agent.jobs import JobController
from chair_sidecar.jobs import PREVIEW_PRESET, _cache_key


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "projects" / "proj_1"
    (project / "interview").mkdir(parents=True)
    (project / "interview" / "take1.mov").write_bytes(b"video")
    (project / "interview" / "notes.txt").write_bytes(b"not media")
    (project / "hero.png").write_bytes(b"image")
    (project / "score.wav").write_bytes(b"audio")
    return project


def _seed_proxy(proxies: Path, source: Path) -> None:
    proxies.mkdir(parents=True, exist_ok=True)
    key = _cache_key(source.resolve(), PREVIEW_PRESET)
    (proxies / f"preview-{key}.mp4").write_bytes(b"proxy")


def test_assets_lists_folders_media_and_pieces(tmp_path: Path) -> None:
    project = _project(tmp_path)
    proxies = tmp_path / "proxies"
    _seed_proxy(proxies, project / "interview" / "take1.mov")

    body = build_assets(
        "proj_1", projects_dir=tmp_path / "projects", proxies=proxies
    )

    assert body["project_id"] == "proj_1"
    assert body["folders"] == [
        {"id": "interview", "name": "interview", "asset_ids": ["interview/take1.mov"]}
    ]
    by_id = {asset["id"]: asset for asset in body["assets"]}
    assert by_id["interview/take1.mov"] == {
        "id": "interview/take1.mov",
        "name": "take1.mov",
        "kind": "video",
        "proxy": "ready",
    }
    assert by_id["hero.png"]["kind"] == "image"
    assert by_id["hero.png"]["proxy"] == "missing"
    assert by_id["score.wav"]["kind"] == "audio"
    assert "interview/notes.txt" not in by_id
    assert {"id": "hero-key-art", "name": "Hero key art"} in body["pieces"]
    assert len(body["pieces"]) == 8


def test_assets_unknown_project_lists_empty(tmp_path: Path) -> None:
    body = build_assets("proj_nope", projects_dir=tmp_path / "projects")

    assert body["folders"] == []
    assert body["assets"] == []
    assert body["pieces"] != []


@pytest.mark.parametrize("project_id", ["..", "../..", "/etc", "a/../../b"])
def test_assets_traversal_lists_empty(tmp_path: Path, project_id: str) -> None:
    projects = tmp_path / "projects"
    projects.mkdir()
    (tmp_path / "outside.mov").write_bytes(b"video")

    body = build_assets(project_id, projects_dir=projects)

    assert body["folders"] == []
    assert body["assets"] == []


def _serve(tmp_path: Path) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    Handler.controller = JobController(tmp_path / "jobs.json")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def test_http_assets_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    proxies = tmp_path / "proxies"
    _seed_proxy(proxies, project / "hero.png")
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(tmp_path / "projects"))
    monkeypatch.setenv("CHAIR_PROXY_DIR", str(proxies))
    server, thread, base = _serve(tmp_path)
    try:
        with urlopen(f"{base}/projects/proj_1/assets") as response:
            assert response.status == 200
            assert response.headers["access-control-allow-origin"] == "*"
            body = json.load(response)
        assert body["project_id"] == "proj_1"
        assert body["folders"][0]["id"] == "interview"
        by_id = {asset["id"]: asset for asset in body["assets"]}
        assert by_id["hero.png"]["proxy"] == "ready"
        assert by_id["interview/take1.mov"]["proxy"] == "missing"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
