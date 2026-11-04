"""Open a named project in DaVinci Resolve Studio (capability: openProject).

Chair enters a project only once the editor is on it (#314). When Studio
is closed it is launched in a system-agnostic way — `CHAIR_RESOLVE_BIN`
wins, otherwise the OS default path — and the project is loaded through
the ProjectManager, but only when it isn't already the current one.
Read-only besides the load: never touches Fusion, never retimes.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from chair_resolve.read import ResolveClosedError, resolve_app

LOCK_PATH = "/tmp/chair-resolve.lock"


class OpenProjectError(RuntimeError):
    """Studio could not be put on the requested project."""


def resolve_launch_command(
    *, platform: str | None = None, env: dict[str, str] | None = None
) -> list[str]:
    """System-agnostic Studio launch command.

    `CHAIR_RESOLVE_BIN` overrides the default: Linux
    `/opt/resolve/bin/resolve`, macOS `open -a "DaVinci Resolve"`,
    Windows the Program Files install.
    """
    environ = env if env is not None else os.environ
    override = environ.get("CHAIR_RESOLVE_BIN", "").strip()
    if override:
        return [override]
    plat = platform if platform is not None else sys.platform
    if plat.startswith("darwin"):
        return ["open", "-a", "DaVinci Resolve"]
    if plat.startswith("win"):
        program_files = environ.get("ProgramFiles", r"C:\Program Files")
        return [
            os.path.join(
                program_files,
                "Blackmagic Design",
                "DaVinci Resolve",
                "Resolve.exe",
            )
        ]
    return ["/opt/resolve/bin/resolve"]


def lock_path(env: dict[str, str] | None = None) -> str:
    """Resolve lock file; `CHAIR_RESOLVE_LOCK` overrides it (tests)."""
    environ = env if env is not None else os.environ
    return environ.get("CHAIR_RESOLVE_LOCK", "").strip() or LOCK_PATH


@contextmanager
def hold_resolve_lock(
    project: str, *, path: str | None = None, timeout_s: float = 180.0
) -> Iterator[None]:
    """Hold the Resolve lock while scripting; wait when another agent has it.

    The file carries `<name> <pid> <iso time>` and is removed on release.
    """
    lock = path if path is not None else lock_path()
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise OpenProjectError(
                    "Another Chair session is using Resolve; "
                    f"the lock at {lock} never cleared."
                ) from None
            time.sleep(0.5)
            continue
        with os.fdopen(fd, "w") as handle:
            handle.write(
                f"{project} {os.getpid()} {datetime.now(UTC).isoformat()}"
            )
        break
    try:
        yield
    finally:
        try:
            os.unlink(lock)
        except FileNotFoundError:
            pass


def ensure_running(
    *,
    timeout_s: float = 120.0,
    poll_s: float = 1.0,
    launcher: Any = None,
) -> Any:
    """Return the Studio scripting app, launching Studio when closed.

    `launcher` is a seam for tests; the default spawns the OS command
    detached so Chair never inherits the Studio process.
    """
    try:
        return resolve_app()
    except ResolveClosedError:
        pass
    command = resolve_launch_command()
    spawn = launcher if launcher is not None else subprocess.Popen
    try:
        if launcher is None:
            kwargs: dict[str, Any] = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sys.platform != "win32":
                kwargs["start_new_session"] = True
            spawn(command, **kwargs)
        else:
            spawn(command)
    except OSError as exc:
        raise ResolveClosedError(
            f"DaVinci Resolve Studio is closed and {command[0]} would not "
            f"start ({exc}). Start Studio and try again."
        ) from exc
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return resolve_app()
        except ResolveClosedError:
            if time.monotonic() >= deadline:
                raise ResolveClosedError(
                    "DaVinci Resolve Studio was launched but its scripting "
                    "API did not answer. Open a project in Studio and try again."
                ) from None
            time.sleep(poll_s)


def open_project(
    name: str,
    *,
    resolve: Any = None,
    ensure: Any = None,
    lock_timeout_s: float = 180.0,
) -> dict[str, Any]:
    """Load `name` in Studio, only when it isn't already current.

    Returns `{opened, alreadyCurrent, project}`. `resolve` and `ensure`
    are seams for tests; live callers hold the Resolve lock and launch
    Studio through `ensure_running` when it is closed.
    """
    cleaned = name.strip() if isinstance(name, str) else ""
    if not cleaned:
        raise OpenProjectError("openProject needs a project name.")
    launcher = ensure if ensure is not None else ensure_running
    with hold_resolve_lock(cleaned, timeout_s=lock_timeout_s):
        app = resolve if resolve is not None else launcher()
        manager = getattr(app, "GetProjectManager", lambda: None)()
        if manager is None:
            raise OpenProjectError(
                "Resolve Studio answered but has no project manager."
            )
        current = manager.GetCurrentProject()
        current_name = current.GetName() if current is not None else ""
        if isinstance(current_name, str) and current_name == cleaned:
            return {
                "opened": True,
                "alreadyCurrent": True,
                "project": cleaned,
            }
        if not manager.LoadProject(cleaned):
            raise OpenProjectError(
                f'Resolve has no project named "{cleaned}". '
                "Open it in Studio once, then try again."
            )
        return {"opened": True, "alreadyCurrent": False, "project": cleaned}
