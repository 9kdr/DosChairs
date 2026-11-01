import base64
import json
import threading
import types
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_agent.__main__ import Handler
from chair_agent.assets import EditorUnlinkedError, build_assets, import_asset
from chair_agent.jobs import JobController
from chair_agent.review import ReviewUnavailable
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


def _pool_clip(path: str):
    return types.SimpleNamespace(GetClipProperty=lambda key: {"File Path": path}.get(key, ""))


def _pool_folder(clips, subs=()):
    return types.SimpleNamespace(
        GetClipList=lambda: list(clips), GetSubFolderList=lambda: list(subs)
    )


class _FakePool:
    def __init__(self, root, imported: list, fail: bool = False) -> None:
        self._root = root
        self.imported = imported
        self._fail = fail

    def GetRootFolder(self):
        return self._root

    def ImportMedia(self, clips: list) -> list:
        if self._fail:
            return [None]
        self.imported.extend(clips)
        return [object() for _ in clips]


def _studio(name: str, root, imported: list | None = None, fail: bool = False):
    pool = _FakePool(root, imported if imported is not None else [], fail)
    project = types.SimpleNamespace(GetName=lambda: name, GetMediaPool=lambda: pool)
    return types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )


def _file_editor_root(tmp_path: Path) -> Path:
    root = tmp_path / "projects"
    root.mkdir(parents=True, exist_ok=True)
    (root / "film.kdenlive").write_text("<mlt/>", encoding="utf-8")
    (root / "clip.mov").write_bytes(b"video")
    (root / "notes.txt").write_bytes(b"not media")
    return root


def test_assets_merges_kdenlive_siblings_with_local(tmp_path: Path) -> None:
    root = _file_editor_root(tmp_path)
    local = root / "kdenlive:film"
    local.mkdir()
    (local / "local.png").write_bytes(b"image")

    body = build_assets("kdenlive:film", projects_dir=root, proxies=tmp_path / "proxies")

    by_id = {asset["id"]: asset for asset in body["assets"]}
    assert by_id["editor/clip.mov"] == {
        "id": "editor/clip.mov",
        "name": "clip.mov",
        "kind": "video",
        "proxy": "missing",
    }
    assert by_id["local.png"]["kind"] == "image"
    assert all("notes.txt" not in asset_id for asset_id in by_id)
    assert all("kdenlive" not in asset_id for asset_id in by_id)
    assert body["folders"] == []


def test_assets_otio_link_lists_and_mismatch_stays_local(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "Show.otio").write_text("{}", encoding="utf-8")
    (root / "a.wav").write_bytes(b"audio")

    linked = build_assets("otio:show", projects_dir=root, proxies=tmp_path / "proxies")
    assert {asset["id"] for asset in linked["assets"]} == {"editor/a.wav"}

    missed = build_assets("otio:other", projects_dir=root, proxies=tmp_path / "proxies")
    assert missed["assets"] == []
    assert missed["folders"] == []


def test_assets_resolve_pool_merges_and_skips_phantoms(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    (media / "a.mov").write_bytes(b"video")
    (media / "b.wav").write_bytes(b"audio")
    (media / "note.txt").write_bytes(b"not media")
    sub = _pool_folder([_pool_clip(str(media / "b.wav"))])
    root = _pool_folder(
        [
            _pool_clip(str(media / "a.mov")),
            _pool_clip(""),
            _pool_clip(str(tmp_path / "ghost.mov")),
            _pool_clip(str(media / "note.txt")),
        ],
        [sub],
    )

    body = build_assets(
        "resolve:demo-film",
        projects_dir=tmp_path / "projects",
        proxies=tmp_path / "proxies",
        studio=_studio("Demo Film", root),
    )

    assert {asset["id"] for asset in body["assets"]} == {"editor/a.mov", "editor/b.wav"}


def test_assets_resolve_closed_or_other_project_lists_local(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    local = root / "resolve:demo-film"
    local.mkdir(parents=True)
    (local / "local.png").write_bytes(b"image")
    pool = _pool_folder([_pool_clip(str(local / "local.png"))])

    closed = build_assets(
        "resolve:demo-film", projects_dir=root, proxies=tmp_path / "proxies", studio=None
    )
    assert {asset["id"] for asset in closed["assets"]} == {"local.png"}

    other = build_assets(
        "resolve:demo-film",
        projects_dir=root,
        proxies=tmp_path / "proxies",
        studio=_studio("Other Project", pool),
    )
    assert {asset["id"] for asset in other["assets"]} == {"local.png"}


def test_assets_editor_entry_wins_a_tie_and_prunes_folders(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    local = root / "resolve:demo-film"
    (local / "bin").mkdir(parents=True)
    (local / "bin" / "clip.mov").write_bytes(b"video")
    (local / "bin" / "keep.png").write_bytes(b"image")
    pool = _pool_folder([_pool_clip(str(local / "bin" / "clip.mov"))])

    body = build_assets(
        "resolve:demo-film",
        projects_dir=root,
        proxies=tmp_path / "proxies",
        studio=_studio("Demo Film", pool),
    )

    by_id = {asset["id"]: asset for asset in body["assets"]}
    assert set(by_id) == {"editor/clip.mov", "bin/keep.png"}
    assert body["folders"] == [
        {"id": "bin", "name": "bin", "asset_ids": ["bin/keep.png"]}
    ]


def test_import_to_kdenlive_lands_alongside_and_lists(tmp_path: Path) -> None:
    root = _file_editor_root(tmp_path)

    asset = import_asset(
        "kdenlive:film", "new.mov", b"video-bytes", projects_dir=root, proxies=tmp_path / "proxies"
    )

    assert asset == {
        "id": "editor/new.mov",
        "name": "new.mov",
        "kind": "video",
        "proxy": "missing",
    }
    assert (root / "new.mov").read_bytes() == b"video-bytes"
    body = build_assets("kdenlive:film", projects_dir=root, proxies=tmp_path / "proxies")
    assert "editor/new.mov" in {entry["id"] for entry in body["assets"]}


def test_import_suffixes_on_collision_and_keeps_source(tmp_path: Path) -> None:
    root = _file_editor_root(tmp_path)
    (root / "new.mov").write_bytes(b"orig")

    asset = import_asset(
        "kdenlive:film", "new.mov", b"new", projects_dir=root, proxies=tmp_path / "proxies"
    )

    assert asset["name"] == "new (2).mov"
    assert (root / "new.mov").read_bytes() == b"orig"
    assert (root / "new (2).mov").read_bytes() == b"new"


@pytest.mark.parametrize(
    "project_id", ["kdenlive:gone", "otio:gone", "plain-id", "bogus:film", "kdenlive:", ""]
)
def test_import_unlinked_file_editors_refuse(tmp_path: Path, project_id: str) -> None:
    root = _file_editor_root(tmp_path)

    with pytest.raises(EditorUnlinkedError):
        import_asset(project_id, "new.mov", b"v", projects_dir=root)


def test_import_resolve_closed_or_other_refuses(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()

    with pytest.raises(EditorUnlinkedError):
        import_asset("resolve:demo-film", "new.mov", b"v", projects_dir=root, studio=None)
    with pytest.raises(EditorUnlinkedError):
        import_asset(
            "resolve:demo-film",
            "new.mov",
            b"v",
            projects_dir=root,
            studio=_studio("Other Project", _pool_folder([])),
        )


@pytest.mark.parametrize(
    "name", ["", "  ", ".", "..", "../x.mov", "a/b.mov", "a\\b.mov", "x.mov\0", None, 123]
)
def test_import_rejects_bad_names(tmp_path: Path, name) -> None:
    with pytest.raises(ValueError):
        import_asset("kdenlive:film", name, b"v", projects_dir=tmp_path)


def test_import_rejects_non_media_and_empty_data(tmp_path: Path) -> None:
    root = _file_editor_root(tmp_path)

    with pytest.raises(ValueError, match="not a media file"):
        import_asset("kdenlive:film", "doc.pdf", b"v", projects_dir=root)
    with pytest.raises(ValueError, match="file data"):
        import_asset("kdenlive:film", "new.mov", b"", projects_dir=root)


def test_import_to_resolve_stages_and_imports(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    imported: list = []
    studio = _studio("Demo Film", _pool_folder([]), imported)

    asset = import_asset(
        "resolve:demo-film",
        "new.mov",
        b"v",
        projects_dir=root,
        proxies=tmp_path / "proxies",
        studio=studio,
    )

    staged = root / "resolve:demo-film" / "new.mov"
    assert staged.read_bytes() == b"v"
    assert imported == [str(staged)]
    assert asset == {
        "id": "editor/new.mov",
        "name": "new.mov",
        "kind": "video",
        "proxy": "missing",
    }


def test_import_to_resolve_when_pool_refuses(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    studio = _studio("Demo Film", _pool_folder([]), fail=True)

    with pytest.raises(ReviewUnavailable, match="could not import media"):
        import_asset(
            "resolve:demo-film", "new.mov", b"v", projects_dir=root, studio=studio
        )
    assert (root / "resolve:demo-film" / "new.mov").read_bytes() == b"v"


def _post(base: str, path: str, payload: dict) -> tuple[int, dict]:
    request = Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def test_http_import_roundtrip_lists_from_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _file_editor_root(tmp_path)
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(root))
    monkeypatch.setenv("CHAIR_PROXY_DIR", str(tmp_path / "proxies"))
    server, thread, base = _serve(tmp_path)
    try:
        status, body = _post(
            base,
            "/projects/kdenlive:film/assets",
            {"name": "up.mov", "data": base64.b64encode(b"v").decode()},
        )
        assert status == 200
        assert body["project_id"] == "kdenlive:film"
        assert body["asset"]["id"] == "editor/up.mov"
        with urlopen(f"{base}/projects/kdenlive:film/assets") as response:
            listing = json.load(response)
        assert "editor/up.mov" in {entry["id"] for entry in listing["assets"]}
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_http_import_unlinked_is_409(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _file_editor_root(tmp_path)
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(root))
    monkeypatch.setenv("CHAIR_PROXY_DIR", str(tmp_path / "proxies"))
    server, thread, base = _serve(tmp_path)
    try:
        status, body = _post(
            base,
            "/projects/kdenlive:gone/assets",
            {"name": "up.mov", "data": base64.b64encode(b"v").decode()},
        )
        assert status == 409
        assert body["error"]["code"] == "editor_unlinked"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


@pytest.mark.parametrize(
    "payload",
    [{"name": "up.mov", "data": "!!!"}, {"name": "up.mov"}, {"name": "../up.mov", "data": "dg=="}],
)
def test_http_import_bad_body_is_400(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, payload: dict
) -> None:
    root = _file_editor_root(tmp_path)
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(root))
    monkeypatch.setenv("CHAIR_PROXY_DIR", str(tmp_path / "proxies"))
    server, thread, base = _serve(tmp_path)
    try:
        status, body = _post(base, "/projects/kdenlive:film/assets", payload)
        assert status == 400
        assert body["error"]["code"] == "invalid_asset"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
