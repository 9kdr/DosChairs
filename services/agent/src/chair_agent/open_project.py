"""POST /projects/open: put the editor on the project before Chair enters it.

Home (#314) calls this before entering a project card, so the video
editor is always on the project Chair shows. Resolve loads the project
by name (launching Studio when closed); Kdenlive launches on the
project file. Counters land on /health like the cut counters.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from chair_agent.projects import EDITORS, find_project_file

_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "opened": 0,
    "already_current": 0,
    "last_editor": None,
    "last_error": None,
}


class OpenProjectError(ValueError):
    """The open request itself is off-shape (400)."""


class EditorUnavailable(RuntimeError):
    """The editor could not be reached or launched (503)."""


class ProjectUnknownError(LookupError):
    """The editor has no such project (404)."""


def status_snapshot() -> dict[str, Any]:
    """Health counters: opens, already-current hits, last editor/error."""
    with _LOCK:
        return dict(_STATUS)


def note_opened(*, editor: str, already_current: bool) -> None:
    """Note one confirmed open."""
    with _LOCK:
        _STATUS["opened"] += 1
        if already_current:
            _STATUS["already_current"] += 1
        _STATUS["last_editor"] = editor
        _STATUS["last_error"] = None


def note_failed(*, editor: str | None, error: str) -> None:
    """Note one failed open: the count stays, the error is kept."""
    with _LOCK:
        if editor is not None:
            _STATUS["last_editor"] = editor
        _STATUS["last_error"] = error


def _resolve_open(name: str) -> dict[str, Any]:
    try:
        from chair_resolve.open_project import OpenProjectError, open_project
        from chair_resolve.read import ResolveClosedError
    except ImportError as error:
        raise EditorUnavailable(
            "the Resolve adapter is missing here; run the agent where "
            f"chair-adapter-resolve imports ({error})"
        ) from error
    try:
        return open_project(name)
    except ResolveClosedError as error:
        raise EditorUnavailable(str(error)) from error
    except OpenProjectError as error:
        message = str(error)
        if "no project named" in message:
            raise ProjectUnknownError(message) from error
        raise EditorUnavailable(message) from error


def _kdenlive_open(path: Path | None) -> dict[str, Any]:
    try:
        from chair_kdenlive.open_project import open_project
    except ImportError as error:
        raise EditorUnavailable(
            "the Kdenlive adapter is missing here; run the agent where "
            f"chair-adapter-kdenlive imports ({error})"
        ) from error
    return open_project(path)


def open_in_editor(
    project_id: Any,
    name: Any,
    *,
    resolve_open: Any = None,
    kdenlive_open: Any = None,
    root: Path | None = None,
) -> dict[str, Any]:
    """Put the editor named by `project_id` on the project.

    Returns `{project_id, editor, opened, alreadyCurrent, project}`.
    `resolve_open`/`kdenlive_open` are seams for tests.
    """
    if not isinstance(project_id, str) or ":" not in project_id:
        raise OpenProjectError("open needs a 'project_id' like 'editor:slug'.")
    editor, slug = project_id.split(":", 1)
    if editor not in EDITORS or not slug:
        raise OpenProjectError("open needs a 'project_id' like 'editor:slug'.")
    if editor == "otio":
        raise OpenProjectError(
            "OTIO interchange has no editor app to open; "
            "open the .otio file in your editor by hand."
        )
    label = name.strip() if isinstance(name, str) else ""
    if editor == "resolve":
        if not label:
            raise OpenProjectError(
                "open needs the Resolve project 'name'; "
                "the card id alone cannot load it."
            )
        opener = resolve_open if resolve_open is not None else _resolve_open
        try:
            result = opener(label)
        except (EditorUnavailable, ProjectUnknownError):
            raise
        except Exception as error:
            raise EditorUnavailable(str(error)) from error
    else:
        path = find_project_file(slug, editor, root)
        if path is None:
            from chair_kdenlive.manifest import MANIFEST

            raise ProjectUnknownError(
                f'"{label or slug}" is no longer on disk: '
                + MANIFEST.fallbacks["openProject"]
            )
        opener = kdenlive_open if kdenlive_open is not None else _kdenlive_open
        try:
            result = opener(path)
        except Exception as error:
            raise EditorUnavailable(str(error)) from error
    body: dict[str, Any] = {
        "project_id": project_id,
        "editor": editor,
        "opened": bool(result.get("opened")),
        "alreadyCurrent": bool(result.get("alreadyCurrent")),
        "project": result.get("project"),
    }
    if result.get("fallback"):
        body["fallback"] = result["fallback"]
    note_opened(editor=editor, already_current=body["alreadyCurrent"])
    return body
