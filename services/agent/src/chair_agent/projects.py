"""Detected projects across editors: GET /projects.

Home (issue #188) lists what this endpoint reports — the project open in
Resolve Studio right now, plus `.kdenlive` and `.otio` project files on
disk — instead of hardcoded constants. Per-editor reachability rides
along as data: a closed Studio is a `stopped` editor with no projects,
not an HTTP error, so home can say so in plain words.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

EDITORS = ("resolve", "kdenlive", "otio")

FILE_SUFFIXES = {"kdenlive": (".kdenlive",), "otio": (".otio",)}


def projects_root() -> Path:
    """Folder scanned for file-based editor projects."""
    override = os.environ.get("CHAIR_PROJECTS_DIR", "").strip()
    if override:
        return Path(override)
    return Path.home() / "Videos"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _slug(text: str) -> str:
    cleaned: list[str] = []
    dash = False
    for char in text.casefold():
        if char.isalnum():
            cleaned.append(char)
            dash = False
        elif not dash:
            cleaned.append("-")
            dash = True
    return "".join(cleaned).strip("-") or "project"


def current_resolve_project() -> str | None:
    """Name of the project open in Studio, or None when Studio is closed."""
    from chair_resolve.read import ResolveClosedError, resolve_app

    try:
        resolve = resolve_app()
    except ResolveClosedError:
        return None
    manager = getattr(resolve, "GetProjectManager", lambda: None)()
    project = manager.GetCurrentProject() if manager is not None else None
    name = project.GetName() if project is not None else ""
    return name.strip() or None if isinstance(name, str) else None


def find_project_file(
    slug: str, editor: str | None = None, root: Path | None = None
) -> Path | None:
    """Find a file-based project whose stem slug matches `slug`."""
    root = root if root is not None else projects_root()
    editors = (editor,) if editor is not None else ("kdenlive", "otio")
    try:
        entries = sorted(
            (entry for entry in root.iterdir() if entry.is_file()),
            key=lambda entry: entry.name.casefold(),
        )
    except OSError:
        return None
    for entry in entries:
        for ed in editors:
            if entry.suffix.casefold() in FILE_SUFFIXES.get(ed, ()):
                if _slug(entry.stem) == slug:
                    return entry
    return None


def _file_projects(editor: str, root: Path) -> tuple[str, list[dict[str, Any]]]:
    """Projects of one file-based editor found directly inside `root`."""
    try:
        entries = sorted(
            (entry for entry in root.iterdir() if entry.is_file()),
            key=lambda entry: entry.name.casefold(),
        )
    except OSError:
        return "stopped", []
    projects = []
    for entry in entries:
        if entry.suffix.casefold() not in FILE_SUFFIXES[editor]:
            continue
        try:
            edited_at = datetime.fromtimestamp(
                entry.stat().st_mtime, tz=UTC
            ).isoformat()
        except OSError:
            continue
        projects.append(
            {
                "id": f"{editor}:{_slug(entry.stem)}",
                "name": entry.stem,
                "editor": editor,
                "edited_at": edited_at,
                "preview": "On disk",
            }
        )
    return "idle", projects


def detect_projects(
    root: Path | None = None,
    *,
    resolve_project: str | None | bool = False,
) -> dict[str, Any]:
    """Detect projects across editors.

    `resolve_project` is a seam for tests: False (default) probes Studio,
    None means Studio is closed, and a string is the open project name.
    """
    root = root if root is not None else projects_root()
    editors: list[dict[str, str]] = []
    projects: list[dict[str, Any]] = []

    if resolve_project is False:
        try:
            open_name: str | None = current_resolve_project()
        except ImportError:
            open_name = None
    else:
        open_name = resolve_project if isinstance(resolve_project, str) else None
    if open_name:
        editors.append({"id": "resolve", "status": "inProject"})
        projects.append(
            {
                "id": f"resolve:{_slug(open_name)}",
                "name": open_name,
                "editor": "resolve",
                "edited_at": _utc_now(),
                "preview": "Open now",
            }
        )
    else:
        editors.append({"id": "resolve", "status": "stopped"})

    for editor in ("kdenlive", "otio"):
        status, found = _file_projects(editor, root)
        editors.append({"id": editor, "status": status})
        projects.extend(found)

    return {"editors": editors, "projects": projects}
