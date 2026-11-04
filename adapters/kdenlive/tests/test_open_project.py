"""Kdenlive openProject: launch on the file, fallback without one."""

from chair_kdenlive import open_project as opener
from chair_kdenlive.manifest import MANIFEST


def test_open_project_launches_kdenlive_on_file() -> None:
    launched: list[list[str]] = []
    body = opener.open_project("/tmp/Trailer.kdenlive", launcher=launched.append)
    assert launched == [["kdenlive", "/tmp/Trailer.kdenlive"]]
    assert body == {
        "opened": True,
        "alreadyCurrent": False,
        "project": "Trailer",
    }


def test_open_project_without_path_returns_manifest_fallback() -> None:
    launched: list[list[str]] = []
    body = opener.open_project(None, launcher=launched.append)
    assert launched == []
    assert body["opened"] is False
    assert body["fallback"] == MANIFEST.fallbacks["openProject"]


def test_manifest_declares_open_project() -> None:
    assert MANIFEST.capabilities.open_project is True
    assert MANIFEST.fallbacks["openProject"] != ""
