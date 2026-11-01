"""Project asset listing: real files on disk plus piece refs from the catalog.

GET /projects/:id/assets serves this listing so the desktop shelf shows
what is actually in the project: media files under CHAIR_PROJECTS_DIR/<id>
(grouped by top-level folder), per-asset proxy availability, and piece refs
from the piece catalog. A missing project dir is an empty listing, never
an error; malformed ids that escape the projects root are treated the
same, so the shelf renders an empty state instead of fakes.
"""

import hashlib
import os
from pathlib import Path
from typing import Any

from chair_agent.pieces.catalog import PIECES
from chair_agent.review import ReviewUnavailable

IMAGE_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"})
AUDIO_EXTENSIONS = frozenset({"wav", "mp3", "aif", "aiff", "flac", "m4a"})
VIDEO_EXTENSIONS = frozenset({"mov", "mp4", "m4v", "mkv", "webm", "avi", "mxf"})

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
) -> dict[str, Any]:
    """List one project's folders, assets, and piece refs from real data.

    Unknown projects and ids that escape the projects root list empty:
    the shelf shows its empty state, never fakes.
    """
    root = projects_dir.resolve() if projects_dir is not None else projects_root()
    project_dir = (root / project_id).resolve() if project_id else root
    if not project_dir.is_relative_to(root) or not project_dir.is_dir():
        folders: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
    else:
        proxy_root = proxies.resolve() if proxies is not None else proxy_dir()
        folders, assets = _scan(project_dir, proxy_root)
    return {
        "project_id": project_id,
        "folders": folders,
        "assets": assets,
        "pieces": [{"id": piece.id, "name": piece.title} for piece in PIECES],
    }
