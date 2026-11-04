"""Install Chair effect specs as OGraf titles for Resolve Studio.

Resolve scans ``.../Fusion/Templates/Edit/Titles/OGraf/`` for ``.ograf.json``
manifests next to their ``.js`` component; dropping the two files from
``exportOGraf`` (packages/effects) into that folder makes the effect show up
under Effects > Titles > OGraf. Installing is a file copy, so it never touches
the open timeline; putting the title on the cut still goes through
:func:`place_ograf_title`, which tries the scripting call first and otherwise
reports the drag-by-hand fallback.

NOTE: if #232 lands ``adapters/resolve/src/chair_resolve/fusion.py`` with
shared per-OS Fusion path logic, re-point :func:`ograf_dir` at it; the tiny
helper here keeps this module independent until then.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

from chair_resolve.fusion import title_template_dir

REQUIRED_MANIFEST_KEYS = (
    "$schema",
    "id",
    "name",
    "main",
    "supportsRealTime",
    "supportsNonRealTime",
)


def ograf_dir(base: Path | str | None = None) -> Path:
    """Folder Resolve scans for OGraf titles: the Fusion Titles folder's OGraf
    subfolder. Per-OS logic lives in fusion.title_template_dir (landed via
    #232); this only appends OGraf.
    """
    if base is not None:
        return Path(base)
    return title_template_dir() / "OGraf"


def title_stem(title_id: str) -> str:
    """File stem for an installed title: ``chair-<slug>``, no slashes."""
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(title_id))
    slug = "-".join(part for part in slug.split("-") if part)[:48]
    return f"chair-{slug or 'effect'}"


def install_ograf(
    manifest: dict[str, Any],
    js: str,
    dest: Path | str | None = None,
    pack: bool = False,
) -> dict[str, Any]:
    """Write ``<stem>.ograf.json`` + ``<stem>.js`` where Resolve scans them.

    Returns ``{"title_name", "stem", "dir", "files", "packed"}``; ``packed``
    is the ``.ograf`` zip path when ``pack`` is true (same layout as the
    kit's ``Scripts/build-dotograf.sh``: the two files at the zip root).
    Raises :class:`ValueError` when the manifest misses a Resolve-required
    key, so a bad bundle never lands half-written.
    """
    if not isinstance(manifest, dict):
        raise TypeError("OGraf manifest must be an object.")
    missing = [key for key in REQUIRED_MANIFEST_KEYS if key not in manifest]
    if missing:
        raise ValueError(f"OGraf manifest is missing {missing}.")
    if not isinstance(js, str) or not js.strip():
        raise ValueError("OGraf component source must be a non-empty string.")
    if manifest.get("supportsNonRealTime") is not True:
        raise ValueError("OGraf manifest for Resolve needs supportsNonRealTime true.")
    stem = title_stem(str(manifest.get("id", "")))
    folder = ograf_dir(dest)
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = folder / f"{stem}.ograf.json"
    js_path = folder / f"{stem}.js"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    js_path.write_text(js, encoding="utf-8")
    packed: str | None = None
    if pack:
        packed_path = folder / f"{stem}.ograf"
        with zipfile.ZipFile(packed_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(manifest_path, arcname=manifest_path.name)
            archive.write(js_path, arcname=js_path.name)
        packed = str(packed_path)
    return {
        "title_name": str(manifest.get("name", stem)),
        "stem": stem,
        "dir": str(folder),
        "files": [str(manifest_path), str(js_path)],
        "packed": packed,
    }


def place_ograf_title(timeline: Any, title_name: str) -> bool:
    """Try scripting placement of an installed OGraf title.

    ``Timeline.InsertFusionTitleIntoTimeline`` is the closest scripting call
    the Studio API documents, but whether it resolves OGraf names is
    unverified (Resolve was in use while this was written). Returns True only
    when the call reports an item; anything else means the person drags the
    title from Effects > Titles > OGraf by hand.
    """
    insert = getattr(timeline, "InsertFusionTitleIntoTimeline", None)
    if insert is None:
        return False
    try:
        return bool(insert(title_name))
    except Exception:
        return False
