"""Bake library pieces to PNG sequences for Resolve on Linux (#308).

Resolve Studio on Linux never loads OGraf titles, so a web piece (a module
like liquid-boxes) cannot land as a title there. The fallback the manifest
names is a baked render: this module renders the piece's frames with alpha at
the clip's fps, resolution, and duration through headless chromium — the same
deterministic seek-to-t OGraf bundle the quality check approves — and the
apply route feeds those PNGs to the existing Loader path as a new comp
version. Re-prompting or editing props re-bakes with the new values.

Frames land under Chair's cache folder, never next to source media, keyed by
module + geometry + props, so re-applying unchanged props reuses the bake.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

BAKE_NOTE = "Baked for Linux; edit in Chair to change it"

#: How long one bake may run: 8s of 1080p30 is hundreds of screenshots.
_RENDER_TIMEOUT_SECONDS = 1200

_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "bakes": 0,
    "frames": 0,
    "last_bake_ms": None,
    "last_frames": None,
    "last_renderer": None,
    "last_error": None,
}


class BakeError(ValueError):
    """A bake failure with the HTTP status the route should answer."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def status_snapshot() -> dict[str, Any]:
    """Health counters: bakes done, frames, last bake ms, last error."""
    with _STATUS_LOCK:
        return dict(_STATUS)


def reset_status() -> None:
    with _STATUS_LOCK:
        _STATUS.update({
            "bakes": 0, "frames": 0,
            "last_bake_ms": None, "last_frames": None,
            "last_renderer": None, "last_error": None,
        })


def _note_bake(
    frames: int, bake_ms: float, error: str | None = None,
    renderer: str | None = None,
) -> None:
    with _STATUS_LOCK:
        if error is None:
            _STATUS["bakes"] += 1
            _STATUS["frames"] += frames
            _STATUS["last_frames"] = frames
            _STATUS["last_renderer"] = renderer
        _STATUS["last_bake_ms"] = bake_ms
        _STATUS["last_error"] = error


def bake_cache_dir() -> Path:
    """Chair's PNG-sequence cache. Never next to source media."""
    base = os.environ.get("XDG_CACHE_HOME", "").strip()
    root = Path(base).expanduser() if base else Path.home() / ".cache"
    return root / "chair" / "bakes"


def ograf_unavailable() -> bool:
    """True when OGraf titles cannot land: Linux, or the manifest says so."""
    try:
        from chair_resolve.manifest import MANIFEST
    except ImportError:
        manifest_says_no = False
    else:
        manifest_says_no = not MANIFEST.capabilities.ograf_titles
    on_linux = sys.platform != "darwin" and os.name != "nt"
    return on_linux or manifest_says_no


def resolve_entry(module_id: str) -> Path:
    """The module's TSX source: a library id or a registered module id."""
    from chair_agent import modules

    if not module_id or "/" in module_id or module_id.startswith("."):
        raise BakeError(f"unknown module {module_id!r}", status=404)
    library = modules.repo_root() / "packages" / "effects" / "library"
    candidate = library / f"{module_id}.tsx"
    if candidate.is_file():
        return candidate
    try:
        record = modules.get_module(module_id)
    except Exception:
        record = None
    if record is not None:
        path = Path(record.source_path)
        if path.is_file():
            return path
    raise BakeError(f"unknown module {module_id!r}", status=404)


def bakeable_layers(
    spec: Mapping[str, Any], sequences: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """Shader layers that name a web module and still need frames.

    A layer bakes when it is a shader without a native look, the caller did
    not already pass a sequence for it, and params.module names the piece.
    Returns one plan per layer: layer id, module, props, and keyframes.
    """
    layers = spec.get("layers")
    if not isinstance(layers, list):
        return []
    plans: list[dict[str, Any]] = []
    for layer in layers:
        if not isinstance(layer, Mapping):
            continue
        if layer.get("type") != "shader":
            continue
        layer_id = str(layer.get("id") or "")
        if not layer_id:
            continue
        params = layer.get("params")
        params = dict(params) if isinstance(params, Mapping) else {}
        if "look" in params:
            continue
        if isinstance(sequences, Mapping) and layer_id in sequences:
            continue
        module_id = params.get("module")
        if not isinstance(module_id, str) or not module_id.strip():
            continue
        props = {
            key: value for key, value in params.items()
            if key != "module" and isinstance(value, (str, int, float, bool))
        }
        plans.append({
            "layer_id": layer_id,
            "module": module_id.strip(),
            "props": props,
            "keyframes": _curves_to_keyframes(layer.get("curves")),
        })
    return plans


def _curves_to_keyframes(curves: Any) -> dict[str, list[list[Any]]] | None:
    """Layer curves to the baked keyframe table ({prop: [[sec, value], ..]})."""
    if not isinstance(curves, Mapping) or not curves:
        return None
    table: dict[str, list[list[Any]]] = {}
    for name, curve in curves.items():
        keys = curve.get("keyframes") if isinstance(curve, Mapping) else None
        if not isinstance(keys, list) or not keys:
            continue
        rows: list[list[Any]] = []
        for key in keys:
            if not isinstance(key, Mapping):
                continue
            moment, value = key.get("time"), key.get("value")
            if not isinstance(moment, (int, float)) or moment < 0:
                continue
            if not isinstance(value, (int, float, str, bool)):
                continue
            rows.append([float(moment), value])
        if rows:
            table[str(name)] = sorted(rows, key=lambda row: row[0])
    return table or None


def _bake_key(
    module_id: str, width: int, height: int, fps: float, duration_sec: float,
    props: Mapping[str, Any], keyframes: Mapping[str, Any] | None,
) -> str:
    digest = hashlib.sha256(json.dumps({
        "module": module_id, "width": width, "height": height,
        "fps": fps, "duration": duration_sec,
        "props": dict(props), "keyframes": keyframes,
    }, sort_keys=True, default=str).encode()).hexdigest()[:16]
    slug = "".join(c if c.isalnum() else "-" for c in module_id)[:40].strip("-")
    return f"{slug or 'piece'}-{width}x{height}@{fps:g}-{digest}"


def _expected_files(out_dir: Path, frames: int) -> list[str] | None:
    """The cached bake's files when every frame is already on disk."""
    files = [
        str(out_dir / f"frame-{index + 1:06d}.png") for index in range(frames)
    ]
    if all(Path(path).is_file() for path in files):
        return files
    return None


def bake_module(
    module_id: str,
    *,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
    props: Mapping[str, Any] | None = None,
    keyframes: Mapping[str, Any] | None = None,
    jobs: int | None = None,
) -> dict[str, Any]:
    """Render a module to PNGs under the bake cache; reuse a cached bake."""
    from chair_agent import modules

    if width <= 0 or height <= 0:
        raise BakeError("bake needs positive width and height")
    if fps <= 0 or duration_sec <= 0:
        raise BakeError("bake needs positive fps and durationSec")
    entry = resolve_entry(module_id)
    frames = max(1, round(duration_sec * fps))
    out_dir = bake_cache_dir() / _bake_key(
        module_id, width, height, fps, duration_sec,
        dict(props or {}), dict(keyframes) if keyframes else None,
    )
    cached = _expected_files(out_dir, frames) if out_dir.is_dir() else None
    if cached is not None:
        _note_bake(0, 0.0)
        return {"files": cached, "frames": frames, "cached": True, "ms": 0.0}
    node = shutil.which("node")
    if node is None:
        raise BakeError("bake needs node on PATH; install it with mise", status=503)
    data = json.dumps({
        "width": width, "height": height, "fps": fps,
        "durationSec": duration_sec, "props": dict(props or {}),
        "keyframes": keyframes, "jobs": jobs,
    })
    started = time.perf_counter()
    try:
        done = subprocess.run(
            [node, str(modules._cli_path()), "render", str(entry),
             "--out", str(out_dir), "--data", data],
            cwd=modules._effects_dir(), capture_output=True, text=True,
            timeout=_RENDER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        _note_bake(0, round((time.perf_counter() - started) * 1000, 1),
                   "bake timed out")
        raise BakeError(
            f"bake of {module_id} timed out after {_RENDER_TIMEOUT_SECONDS}s"
        ) from error
    lines = [line for line in done.stdout.splitlines() if line.strip().startswith("{")]
    if not lines:
        detail = done.stderr.strip()[:400] or "no output"
        _note_bake(0, round((time.perf_counter() - started) * 1000, 1), detail)
        status = 503 if "chromium" in detail.lower() else 502
        raise BakeError(f"bake of {module_id} failed: {detail}", status=status)
    try:
        outcome = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        raise BakeError(f"bake of {module_id} returned bad JSON: {error}") from error
    if not isinstance(outcome, dict) or not outcome.get("files"):
        raise BakeError(f"bake of {module_id} produced no frames")
    bake_ms = round((time.perf_counter() - started) * 1000, 1)
    _note_bake(len(outcome["files"]), bake_ms,
               renderer=outcome.get("renderer"))
    outcome["ms"] = bake_ms
    outcome["cached"] = False
    return outcome


def bake_for_apply(
    spec: Mapping[str, Any], sequences: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], list[str]]:
    """Bake every bakeable layer; returns merged sequences and notes."""
    plans = bakeable_layers(spec, sequences)
    if not plans:
        return dict(sequences or {}), []
    try:
        width = int(spec.get("width", 0))
        height = int(spec.get("height", 0))
        fps = float(spec.get("fps", 0))
        duration_sec = float(spec.get("durationSec", 0))
    except (TypeError, ValueError) as error:
        raise BakeError(
            f"bake needs width, height, fps, durationSec: {error}"
        ) from error
    merged = dict(sequences or {})
    for plan in plans:
        outcome = bake_module(
            plan["module"], width=width, height=height, fps=fps,
            duration_sec=duration_sec, props=plan["props"],
            keyframes=plan["keyframes"],
        )
        merged[plan["layer_id"]] = {"files": outcome["files"]}
    return merged, [BAKE_NOTE]
