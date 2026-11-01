"""Project asset listing: real files on disk plus piece refs from the catalog.

GET /projects/:id/assets serves this listing so the desktop shelf shows
what is actually in the project: media files under CHAIR_PROJECTS_DIR/<id>
(grouped by top-level folder), per-asset proxy availability, and piece refs
from the piece catalog. A missing project dir is an empty listing, never
an error; malformed ids that escape the projects root are treated the
same, so the shelf renders an empty state instead of fakes.

Ids shaped like the /projects detector's (editor:slug) also merge the
linked editor's library: Resolve's media pool while that Studio project is
open, or the media files sitting next to the .kdenlive/.otio project file.
POST /projects/:id/assets is the explicit Import action, the one write
against the editor: the file lands in that same library (Resolve: media
pool import; file editors: alongside the project file), never overwriting.
Unlinked editors and a closed Studio keep the Chair-local listing and
refuse imports, with no errors on reads and no phantom entries.
"""

import hashlib
import os
from pathlib import Path
from typing import Any

from chair_agent.pieces.catalog import PIECES
from chair_agent.projects import _slug as _project_slug
from chair_agent.review import ReviewUnavailable

try:  # The agent runs without editor adapters; then listings stay Chair-local.
    from chair_resolve.read import ResolveClosedError as _ResolveClosedError
    from chair_resolve.read import media_pool_files as _media_pool_files
    from chair_resolve.read import resolve_app as _resolve_app_factory
    from chair_resolve.write import import_media as _studio_import_media
except ImportError:
    _ResolveClosedError = None
    _media_pool_files = None
    _resolve_app_factory = None
    _studio_import_media = None

IMAGE_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"})
AUDIO_EXTENSIONS = frozenset({"wav", "mp3", "aif", "aiff", "flac", "m4a"})
VIDEO_EXTENSIONS = frozenset({"mov", "mp4", "m4v", "mkv", "webm", "avi", "mxf"})

LINKED_EDITORS = frozenset({"resolve", "kdenlive", "otio"})

# Mirrors chair_agent.projects.FILE_SUFFIXES: the file a link resolves to.
FILE_SUFFIXES = {"kdenlive": (".kdenlive",), "otio": (".otio",)}


class EditorUnlinkedError(Exception):
    """No linked editor for this project: Studio is closed or the file is gone."""

# Must match PREVIEW_PRESET in services/sidecar/src/chair_sidecar/jobs.py.
PREVIEW_PRESET = "preview-640"


def projects_root() -> Path:
    """Where project media lives: CHAIR_PROJECTS_DIR, else data/projects."""
    configured = os.environ.get("CHAIR_PROJECTS_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    root = Path(os.environ.get("CHAIR_ROOT", ".")).expanduser()
    return (root / "data" / "projects").resolve()


def proxy_dir() -> Path:
    """Where the sidecar writes previews: CHAIR_PROXY_DIR, else data/proxies."""
    configured = os.environ.get("CHAIR_PROXY_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    root = Path(os.environ.get("CHAIR_ROOT", ".")).expanduser()
    return (root / "data" / "proxies").resolve()


def kind_for(name: str) -> str | None:
    """Media kind by extension, or None for files the shelf skips."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return None


def proxy_ready(source: Path, proxies: Path) -> bool:
    """Whether the sidecar already rendered a preview for this source.

    Mirrors the sidecar preview cache name (preview-<sha>.mp4 over the
    resolved source path, size, mtime, and preset). Same machine, same
    inputs, so the listing can report availability without asking the
    sidecar. Read-only: a missing proxy dir means nothing is ready.
    """
    try:
        stat = source.stat()
    except OSError:
        return False
    payload = "\0".join(
        (str(source), str(stat.st_size), str(stat.st_mtime_ns), PREVIEW_PRESET)
    )
    key = hashlib.sha256(payload.encode()).hexdigest()[:24]
    return (proxies / f"preview-{key}.mp4").is_file()


def _scan(project_dir: Path, proxies: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    assets: list[dict[str, Any]] = []
    members: dict[str, list[str]] = {}
    try:
        entries = sorted(project_dir.rglob("*"), key=lambda path: path.as_posix())
    except OSError as error:
        raise ReviewUnavailable(
            "assets_unavailable", f"cannot read {project_dir}: {error}"
        ) from error
    for entry in entries:
        if not entry.is_file():
            continue
        kind = kind_for(entry.name)
        if kind is None:
            continue
        source = entry.resolve()
        asset_id = source.relative_to(project_dir).as_posix()
        assets.append(
            {
                "id": asset_id,
                "name": entry.name,
                "kind": kind,
                "proxy": "ready" if proxy_ready(source, proxies) else "missing",
            }
        )
        parts = asset_id.split("/")
        if len(parts) > 1:
            members.setdefault(parts[0], []).append(asset_id)
    folders = [
        {"id": folder, "name": folder, "asset_ids": sorted(ids)}
        for folder, ids in sorted(members.items())
    ]
    return folders, assets


def build_assets(
    project_id: str,
    *,
    projects_dir: Path | None = None,
    proxies: Path | None = None,
    studio: Any = False,
) -> dict[str, Any]:
    """List one project's folders, assets, and piece refs from real data.

    Unknown projects and ids that escape the projects root list empty:
    the shelf shows its empty state, never fakes. Editor-shaped ids
    (editor:slug) merge the linked editor's library on top; anything
    unlinked reads Chair-local only. `studio` is a seam for tests: False
    (default) probes Studio, None means Studio is closed, and any other
    object is used as the Resolve app.
    """
    root = projects_dir.resolve() if projects_dir is not None else projects_root()
    project_dir = (root / project_id).resolve() if project_id else root
    proxy_root = proxies.resolve() if proxies is not None else proxy_dir()
    if not project_dir.is_relative_to(root) or not project_dir.is_dir():
        folders: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
    else:
        folders, assets = _scan(project_dir, proxy_root)
    editor, slug = _editor_link(project_id)
    if editor is not None and slug is not None:
        paths = _editor_files(editor, slug, root, studio)
        if paths:
            assets, folders = _merge_editor_assets(
                assets, folders, project_dir, paths, proxy_root
            )
    return {
        "project_id": project_id,
        "folders": folders,
        "assets": assets,
        "pieces": [{"id": piece.id, "name": piece.title} for piece in PIECES],
    }


def import_asset(
    project_id: str,
    name: Any,
    data: bytes,
    *,
    projects_dir: Path | None = None,
    proxies: Path | None = None,
    studio: Any = False,
) -> dict[str, Any]:
    """Store one imported file in the linked editor's library.

    Resolve: staged under CHAIR_PROJECTS_DIR/<id> (ImportMedia needs a file)
    then imported into the open Studio project's media pool. Kdenlive/OTIO:
    stored alongside the project file. Names are suffixed on collision, so
    an import never overwrites. Raises EditorUnlinkedError without a link,
    ValueError for a bad name or a file the shelf would not list.
    """
    clean = _clean_import_name(name)
    kind = kind_for(clean)
    if kind is None:
        raise ValueError(f"Import {clean!r} is not a media file the shelf lists.")
    if not isinstance(data, bytes) or not data:
        raise ValueError("Import needs file data.")
    root = projects_dir.resolve() if projects_dir is not None else projects_root()
    editor, slug = _editor_link(project_id)
    proxy_root = proxies.resolve() if proxies is not None else proxy_dir()
    if editor == "resolve" and slug is not None:
        return _import_to_resolve(root, project_id, slug, clean, kind, data, proxy_root, studio)
    if editor in ("kdenlive", "otio") and slug is not None:
        return _import_to_file_editor(root, editor, slug, clean, kind, data, proxy_root)
    raise EditorUnlinkedError(f"Project {project_id!r} has no linked editor.")


def _editor_link(project_id: str) -> tuple[str | None, str | None]:
    """Split editor:slug ids; anything else is a plain Chair-local id."""
    editor, sep, slug = project_id.partition(":")
    if not sep or editor not in LINKED_EDITORS or not slug:
        return None, None
    return editor, slug


def _editor_files(editor: str, slug: str, root: Path, studio: Any) -> list[Path]:
    """Absolute media paths from the linked editor, or [] when unlinked."""
    if editor == "resolve":
        return _resolve_pool_files(slug, studio)
    project_file = _file_project_path(root, editor, slug)
    if project_file is None:
        return []
    try:
        entries = sorted(
            (entry for entry in project_file.parent.iterdir() if entry.is_file()),
            key=lambda entry: entry.name.casefold(),
        )
    except OSError:
        return []
    return [entry for entry in entries if kind_for(entry.name) is not None]


def _file_project_path(root: Path, editor: str, slug: str) -> Path | None:
    """The project file whose stem slug matches, mirroring /projects order."""
    try:
        entries = sorted(
            (entry for entry in root.iterdir() if entry.is_file()),
            key=lambda entry: entry.name.casefold(),
        )
    except OSError:
        return None
    for entry in entries:
        if entry.suffix.casefold() not in FILE_SUFFIXES[editor]:
            continue
        if _project_slug(entry.stem) == slug:
            return entry
    return None


def _resolve_app(studio: Any) -> Any:
    """The Studio app: an injected object, None when closed, or a live probe."""
    if studio is not False:
        return studio
    if _resolve_app_factory is None:
        return None
    try:
        return _resolve_app_factory()
    except _ResolveClosedError:
        return None


def _open_project_name(app: Any) -> str | None:
    manager = getattr(app, "GetProjectManager", lambda: None)()
    project = manager.GetCurrentProject() if manager is not None else None
    name = project.GetName() if project is not None else ""
    return name.strip() or None if isinstance(name, str) else None


def _resolve_pool_files(slug: str, studio: Any) -> list[Path]:
    """Media pool files when Studio has this project open, else []."""
    if _media_pool_files is None:
        return []
    app = _resolve_app(studio)
    if app is None:
        return []
    name = _open_project_name(app)
    if name is None or _project_slug(name) != slug:
        return []
    try:
        return [Path(path) for path in _media_pool_files(app)]
    except _ResolveClosedError:
        return []


def _merge_editor_assets(
    assets: list[dict[str, Any]],
    folders: list[dict[str, Any]],
    project_dir: Path,
    paths: list[Path],
    proxies: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Union Chair-local assets with editor files; the editor entry wins a tie."""
    merged: list[dict[str, Any]] = []
    editor_paths: set[str] = set()
    used_ids = {asset["id"] for asset in assets}
    for path in paths:
        try:
            source = path.resolve()
        except OSError:
            continue
        if not source.is_file():
            continue
        kind = kind_for(source.name)
        if kind is None or str(source) in editor_paths:
            continue
        editor_paths.add(str(source))
        asset_id = _unique_editor_id(source.name, used_ids)
        used_ids.add(asset_id)
        merged.append(
            {
                "id": asset_id,
                "name": source.name,
                "kind": kind,
                "proxy": "ready" if proxy_ready(source, proxies) else "missing",
            }
        )
    if not merged:
        return assets, folders
    kept = [
        asset for asset in assets if _local_source(project_dir, asset["id"]) not in editor_paths
    ]
    live = {asset["id"] for asset in kept}
    pruned = []
    for folder in folders:
        ids = [asset_id for asset_id in folder["asset_ids"] if asset_id in live]
        if ids:
            pruned.append({"id": folder["id"], "name": folder["name"], "asset_ids": ids})
    return kept + merged, pruned


def _local_source(project_dir: Path, asset_id: str) -> str | None:
    try:
        return str((project_dir / asset_id).resolve())
    except OSError:
        return None


def _unique_editor_id(name: str, used: set[str]) -> str:
    candidate = f"editor/{name}"
    if candidate not in used:
        return candidate
    head, sep, tail = name.rpartition(".")
    stem, ext = (head, sep + tail) if sep else (name, "")
    n = 2
    while candidate in used:
        candidate = f"editor/{stem} ({n}){ext}"
        n += 1
    return candidate


def _clean_import_name(name: Any) -> str:
    if not isinstance(name, str):
        raise ValueError("Import needs a file name.")
    clean = name.strip()
    if not clean or clean in {".", ".."} or "/" in clean or "\\" in clean or "\0" in clean:
        raise ValueError(f"Import name {name!r} is not a plain file name.")
    return clean


def _unique_path(directory: Path, name: str) -> Path:
    """A new path that never overwrites: suffixes (2), (3), ... on collision."""
    candidate = directory / name
    if not candidate.exists():
        return candidate
    head, sep, tail = name.rpartition(".")
    stem, ext = (head, sep + tail) if sep else (name, "")
    n = 2
    while (candidate := directory / f"{stem} ({n}){ext}").exists():
        n += 1
    return candidate


def _store_import(directory: Path, clean: str, data: bytes) -> Path:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        dest = _unique_path(directory, clean)
        dest.write_bytes(data)
    except OSError as error:
        raise ReviewUnavailable(
            "assets_unavailable", f"cannot store {clean}: {error}"
        ) from error
    return dest


def _import_to_file_editor(
    root: Path,
    editor: str,
    slug: str,
    clean: str,
    kind: str,
    data: bytes,
    proxies: Path,
) -> dict[str, Any]:
    project_file = _file_project_path(root, editor, slug)
    if project_file is None:
        raise EditorUnlinkedError(f"No {editor} project file is linked to this project.")
    dest = _store_import(project_file.parent, clean, data)
    return {
        "id": f"editor/{dest.name}",
        "name": dest.name,
        "kind": kind,
        "proxy": "ready" if proxy_ready(dest.resolve(), proxies) else "missing",
    }


def _import_to_resolve(
    root: Path,
    project_id: str,
    slug: str,
    clean: str,
    kind: str,
    data: bytes,
    proxies: Path,
    studio: Any,
) -> dict[str, Any]:
    app = _resolve_app(studio)
    name = _open_project_name(app) if app is not None else None
    if name is None or _project_slug(name) != slug:
        raise EditorUnlinkedError("Resolve Studio has this project closed.")
    if _studio_import_media is None:
        raise EditorUnlinkedError("The Resolve adapter is not installed.")
    dest = _store_import((root / project_id).resolve(), clean, data)
    closed = (_ResolveClosedError,) if _ResolveClosedError is not None else ()
    try:
        _studio_import_media(str(dest), app)
    except closed as error:
        raise EditorUnlinkedError("Resolve Studio closed during import.") from error
    except RuntimeError as error:
        raise ReviewUnavailable("import_failed", str(error)) from error
    return {
        "id": f"editor/{dest.name}",
        "name": dest.name,
        "kind": kind,
        "proxy": "ready" if proxy_ready(dest.resolve(), proxies) else "missing",
    }
