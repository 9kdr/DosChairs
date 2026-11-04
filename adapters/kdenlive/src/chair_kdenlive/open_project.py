"""Kdenlive side of openProject (#314): launch the app on the file.

Kdenlive projects are files, so `open_project` shells `kdenlive <file>`
when a project file path is known. Without a path there is nothing to
launch — the caller reports the manifest fallback instead.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from chair_kdenlive.manifest import MANIFEST


def open_project(
    file: str | Path | None, *, launcher: Any = None
) -> dict[str, Any]:
    """Open `file` in Kdenlive; fallback payload when no path is known."""
    if file is None or str(file).strip() == "":
        return {
            "opened": False,
            "alreadyCurrent": False,
            "project": None,
            "fallback": MANIFEST.fallbacks["openProject"],
        }
    command = ["kdenlive", str(file)]
    spawn = launcher if launcher is not None else subprocess.Popen
    try:
        if launcher is None:
            spawn(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            spawn(command)
    except OSError as exc:
        return {
            "opened": False,
            "alreadyCurrent": False,
            "project": Path(str(file)).stem,
            "fallback": f"kdenlive would not start ({exc}): "
            + MANIFEST.fallbacks["openProject"],
        }
    return {
        "opened": True,
        "alreadyCurrent": False,
        "project": Path(str(file)).stem,
    }
