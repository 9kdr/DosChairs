"""openProject: launch-path choice, load-only-if-not-current, lock."""

from pathlib import Path

import pytest
from chair_resolve import open_project as opener
from chair_resolve.manifest import MANIFEST
from chair_resolve.read import ResolveClosedError


class _FakeProject:
    def __init__(self, name: str) -> None:
        self._name = name

    def GetName(self) -> str:
        return self._name


class _FakeManager:
    def __init__(self, current: str | None, known: set[str]) -> None:
        self._current = current
        self.loads: list[str] = []
        self._known = known

    def GetCurrentProject(self) -> _FakeProject | None:
        return _FakeProject(self._current) if self._current else None

    def LoadProject(self, name: str) -> bool:
        self.loads.append(name)
        if name in self._known:
            self._current = name
            return True
        return False


class _FakeResolve:
    def __init__(self, manager: _FakeManager) -> None:
        self._manager = manager

    def GetProjectManager(self) -> _FakeManager:
        return self._manager


def test_launch_command_defaults_per_os() -> None:
    assert opener.resolve_launch_command(platform="linux", env={}) == [
        "/opt/resolve/bin/resolve"
    ]
    assert opener.resolve_launch_command(platform="darwin", env={}) == [
        "open",
        "-a",
        "DaVinci Resolve",
    ]
    assert opener.resolve_launch_command(platform="win32", env={}) == [
        str(
            Path(r"C:\Program Files")
            / "Blackmagic Design"
            / "DaVinci Resolve"
            / "Resolve.exe"
        )
    ]


def test_launch_command_env_override_wins_on_every_os() -> None:
    env = {"CHAIR_RESOLVE_BIN": "/custom/studio"}
    for platform in ("linux", "darwin", "win32"):
        assert opener.resolve_launch_command(platform=platform, env=env) == [
            "/custom/studio"
        ]


def test_open_project_skips_load_when_already_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(tmp_path / "resolve.lock"))
    manager = _FakeManager("Chair Captest", {"Chair Captest"})
    body = opener.open_project(
        "Chair Captest", resolve=_FakeResolve(manager)
    )
    assert body == {
        "opened": True,
        "alreadyCurrent": True,
        "project": "Chair Captest",
    }
    assert manager.loads == []


def test_open_project_loads_only_when_needed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(tmp_path / "resolve.lock"))
    manager = _FakeManager("Other", {"Chair Captest", "Other"})
    body = opener.open_project(
        "Chair Captest", resolve=_FakeResolve(manager)
    )
    assert body == {
        "opened": True,
        "alreadyCurrent": False,
        "project": "Chair Captest",
    }
    assert manager.loads == ["Chair Captest"]


def test_open_project_unknown_name_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(tmp_path / "resolve.lock"))
    manager = _FakeManager("Other", {"Other"})
    with pytest.raises(opener.OpenProjectError, match="no project named"):
        opener.open_project("Missing", resolve=_FakeResolve(manager))


def test_open_project_blank_name_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(tmp_path / "resolve.lock"))
    with pytest.raises(opener.OpenProjectError, match="needs a project name"):
        opener.open_project("  ", resolve=_FakeResolve(_FakeManager(None, set())))


def test_lock_released_after_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = tmp_path / "resolve.lock"
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(lock))
    opener.open_project(
        "Chair Captest",
        resolve=_FakeResolve(_FakeManager("Chair Captest", set())),
    )
    assert not lock.exists()


def test_lock_wait_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = tmp_path / "resolve.lock"
    lock.write_text("Other 1 2026-01-01T00:00:00+00:00")
    monkeypatch.setenv("CHAIR_RESOLVE_LOCK", str(lock))
    with pytest.raises(opener.OpenProjectError, match="never cleared"):
        opener.open_project(
            "Chair Captest",
            resolve=_FakeResolve(_FakeManager("Chair Captest", set())),
            lock_timeout_s=0,
        )


def test_ensure_running_launches_when_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    launched: list[list[str]] = []
    calls = {"n": 0}

    def fake_app() -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ResolveClosedError("closed")
        return "resolve"

    monkeypatch.setattr(opener, "resolve_app", fake_app)
    app = opener.ensure_running(
        timeout_s=5, poll_s=0, launcher=launched.append
    )
    assert app == "resolve"
    assert launched == [opener.resolve_launch_command()]


def test_manifest_declares_open_project() -> None:
    assert MANIFEST.capabilities.open_project is True
    assert MANIFEST.fallbacks["openProject"] != ""
