"""Read-only scan of the editor's own Fusion macros and templates (issue #242).

Finds Fusion `Templates/Edit/{Titles,Transitions,Generators,Effects}`,
`Macros`, OGraf titles (`*.ograf.json`) and `.drfx` packs (zip archives of
`.setting` files) under the user and system Fusion folders, and reads each
MacroOperator/GroupOperator's published inputs (name, control type, default,
min/max) so the model can reuse or wrap them.

Nothing here writes. Files are opened for reading only, packs are read
in memory (never extracted), and oversized members are skipped with a
note instead of loaded. Errors land in ScanResult.errors per file: one
broken template never hides the rest.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from chair_resolve.luatable import LuaTableError, Table, parse

MAX_FILE_BYTES = 4_000_000

Kind = Literal["title", "transition", "generator", "effect", "macro", "ograf"]
KINDS: tuple[Kind, ...] = ("title", "transition", "generator", "effect", "macro", "ograf")

_EDIT_FOLDERS: dict[str, Kind] = {
    "titles": "title",
    "transitions": "transition",
    "generators": "generator",
    "effects": "effect",
}

_CONTROL_TYPES = {
    "slidercontrol": "number",
    "screwcontrol": "number",
    "rangecontrol": "number",
    "checkboxcontrol": "boolean",
    "combocontrol": "choice",
    "multibuttoncontrol": "choice",
    "colorcontrol": "color",
    "texteditcontrol": "text",
    "filecontrol": "file",
    "pointcontrol": "point",
    "offsetcontrol": "point",
}
_NOT_CONTROLS = frozenset({"labelcontrol", "buttoncontrol", "imagecontrol"})
_IMAGE_SOURCES = frozenset({"Input", "Background", "Foreground", "EffectMask", "MaskInput"})
_CHANNEL = re.compile(r"(Red|Green|Blue)\d*(Clone)?$")
_GENERIC_KEY = re.compile(r"Input\d+$")


class Control(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str
    name: str
    type: str
    default: str | float | bool | None = None
    min: float | None = None
    max: float | None = None
    choices: tuple[str, ...] | None = None


class MacroPiece(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    name: str
    kind: Kind
    source: Literal["user", "system"]
    path: str
    pack: str | None = None
    controls: tuple[Control, ...] = ()


class ScanResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pieces: list[MacroPiece]
    errors: list[str]
    roots: list[str]
    scanned_at: str


@dataclass(frozen=True)
class FusionRoot:
    path: Path
    source: Literal["user", "system"]


def fusion_roots(
    env: Mapping[str, str] | None = None, home: Path | None = None
) -> list[FusionRoot]:
    """User then system Fusion folders for this OS (CHAIR_FUSION_DIRS overrides)."""
    env = os.environ if env is None else env
    override = env.get("CHAIR_FUSION_DIRS", "").strip()
    if override:
        return [FusionRoot(Path(p), "user") for p in override.split(os.pathsep) if p.strip()]
    home = home or Path.home()
    if os.name == "nt":
        vendor = "Blackmagic Design/DaVinci Resolve/Support/Fusion"
        appdata = Path(env.get("APPDATA", home / "AppData/Roaming"))
        programdata = Path(env.get("PROGRAMDATA", "C:/ProgramData"))
        return [FusionRoot(appdata / vendor, "user"), FusionRoot(programdata / vendor, "system")]
    if sys.platform == "darwin":
        vendor = "Blackmagic Design/DaVinci Resolve"
        base = home / "Library/Application Support" / vendor
        system = Path("/Library/Application Support") / vendor
        return [
            FusionRoot(base / "Fusion", "user"),
            FusionRoot(base / "Support/Fusion", "user"),
            FusionRoot(system / "Fusion", "system"),
        ]
    share = home / ".local/share/DaVinciResolve"
    return [
        FusionRoot(share / "Fusion", "user"),
        FusionRoot(share / "Support/Fusion", "user"),
        FusionRoot(Path("/opt/resolve/Fusion"), "system"),
        FusionRoot(Path("/opt/resolve/Support/Fusion"), "system"),
    ]


def _walk(base: Path, *suffixes: str) -> Iterator[Path]:
    for folder, _dirs, files in os.walk(base, followlinks=False):
        for name in sorted(files):
            if name.lower().endswith(suffixes):
                yield Path(folder) / name


def _kind_of(parts: Sequence[str], fallback: Kind = "macro") -> Kind:
    lowered = [part.lower() for part in parts]
    for index, part in enumerate(lowered[:-1]):
        if part == "edit" and lowered[index + 1] in _EDIT_FOLDERS:
            return _EDIT_FOLDERS[lowered[index + 1]]
    return fallback


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "piece"


def _scalar(value: Any) -> str | float | bool | None:
    return value if isinstance(value, (str, int, float, bool)) else None


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _user_controls(node: Any) -> dict[Any, Table]:
    controls = node.get("UserControls") if isinstance(node, Table) else None
    if not isinstance(controls, Table):
        return {}
    found: dict[Any, Table] = {}
    for key, spec in controls.named.items():
        if isinstance(spec, Table) and not spec.named and spec.items:
            spec = next((item for item in spec.items if isinstance(item, Table)), spec)
        if isinstance(spec, Table):
            found[key] = spec
    return found


def _hex(values: Sequence[Any]) -> str | None:
    if not all(_number(v) is not None for v in values):
        return None
    return "#" + "".join(f"{round(min(1.0, max(0.0, float(v))) * 255):02x}" for v in values)


def _controls_of(operator: Table) -> tuple[Control, ...]:
    inner = operator.get("Tools")
    tools = inner.named if isinstance(inner, Table) else {}
    own = _user_controls(operator)
    inputs = operator.get("Inputs")
    rows: list[tuple[Control, Any, str]] = []  # (control, ControlGroup, Source)
    for key, node in (inputs.named if isinstance(inputs, Table) else {}).items():
        if not isinstance(node, Table) or node.type != "InstanceInput":
            continue
        source = str(node.get("Source", ""))
        key = str(key)
        if not source or key.startswith("MainInput") or source in _IMAGE_SOURCES:
            continue
        tool = tools.get(node.get("SourceOp"))
        spec = own.get(key) or _user_controls(tool).get(source) or Table()
        kind = str(spec.get("INPID_InputControl", "")).lower()
        if kind in _NOT_CONTROLS:
            continue
        live = tool.get("Inputs") if isinstance(tool, Table) else None
        current = live.get(source) if isinstance(live, Table) else None
        default = node.get("Default", spec.get("INP_Default"))
        if default is None and isinstance(current, Table):
            default = current.get("Value")
        default = _scalar(default)
        name = node.get("Name") or spec.get("LINKS_Name")
        if not isinstance(name, str) or not name:
            name = source if _GENERIC_KEY.match(key) else key
        choices = tuple(
            str(item.get("CCS_AddString"))
            for item in spec.items
            if isinstance(item, Table) and "CCS_AddString" in item.named
        )
        if kind in _CONTROL_TYPES:
            ctype = _CONTROL_TYPES[kind]
        elif isinstance(default, bool):
            ctype = "boolean"
        elif isinstance(default, str):
            ctype = "text"
        elif isinstance(default, (int, float)):
            ctype = "number"
        else:
            ctype = "other"
        low = _number(node.get("MinAllowed", node.get("MinScale")))
        high = _number(node.get("MaxAllowed", node.get("MaxScale")))
        if low is None:
            low = _number(spec.get("INP_MinAllowed", spec.get("INP_MinScale")))
        if high is None:
            high = _number(spec.get("INP_MaxAllowed", spec.get("INP_MaxScale")))
        control = Control(
            key=key,
            name=name,
            type=ctype,
            default=default,
            min=low,
            max=high,
            choices=choices or None,
        )
        rows.append((control, node.get("ControlGroup"), source))
    return tuple(_fold_colors(rows))


def _fold_colors(rows: list[tuple[Control, Any, str]]) -> list[Control]:
    """Three published channels sharing a ControlGroup read as one color control."""
    out: list[Control] = []
    index = 0
    while index < len(rows):
        control, group, source = rows[index]
        run = [rows[index]]
        while group is not None and index + len(run) < len(rows):
            if rows[index + len(run)][1] != group:
                break
            run.append(rows[index + len(run)])
        if len(run) >= 3 and all(_CHANNEL.match(r[2]) for r in run[:3]):
            name = re.sub(r"\s*(red|green|blue)$", "", control.name, flags=re.IGNORECASE)
            default = _hex([r[0].default for r in run[:3]])
            out.append(
                Control(key=control.key, name=name or control.name, type="color", default=default)
            )
            out.extend(r[0] for r in run[3:])
            index += len(run)
        else:
            out.append(control)
            index += 1
    return out


def _operators(text: str) -> list[tuple[str, Table]]:
    root = parse(text)
    tools = root.get("Tools") if isinstance(root, Table) else None
    if not isinstance(tools, Table):
        return []
    return [
        (str(name), node)
        for name, node in tools.named.items()
        if isinstance(node, Table) and node.type in ("MacroOperator", "GroupOperator")
    ]


def _setting_pieces(
    text: str, *, member: str, kind: Kind, source: str, path: str, pack: str | None
) -> list[MacroPiece]:
    stem = Path(member).stem
    operators = _operators(text)
    pieces = []
    for name, operator in operators:
        label = stem if len(operators) == 1 else f"{stem} / {name}"
        suffix = "" if len(operators) == 1 else name
        slug = _slug(f"{pack or ''} {Path(member).with_suffix('')} {suffix}")
        pieces.append(
            MacroPiece(
                id=f"macro:{source}:{kind}:{slug}",
                name=label,
                kind=kind,
                source=source,  # type: ignore[arg-type]
                path=path,
                pack=pack,
                controls=_controls_of(operator),
            )
        )
    return pieces


_OGRAF_TYPES = {"string": "text", "number": "number", "integer": "number", "boolean": "boolean"}


def _ograf_pieces(
    text: str, *, member: str, source: str, path: str, pack: str | None
) -> list[MacroPiece]:
    manifest = json.loads(text)
    if not isinstance(manifest, dict):
        raise ValueError("OGraf manifest is not an object")
    schema = manifest.get("schema")
    properties = schema.get("properties") if isinstance(schema, dict) else None
    controls = []
    for key, prop in (properties.items() if isinstance(properties, dict) else []):
        if not isinstance(prop, dict):
            continue
        ctype = _OGRAF_TYPES.get(str(prop.get("type")), "other")
        if str(prop.get("gddType", "")).startswith("color"):
            ctype = "color"
        choices = prop.get("enum")
        if isinstance(choices, list) and choices:
            ctype = "choice"
        controls.append(
            Control(
                key=str(key),
                name=str(prop.get("title") or key),
                type=ctype,
                default=_scalar(prop.get("default")),
                min=_number(prop.get("minimum")),
                max=_number(prop.get("maximum")),
                choices=tuple(str(c) for c in choices) if isinstance(choices, list) and choices
                else None,
            )
        )
    name = str(manifest.get("name") or manifest.get("id") or Path(member).name)
    return [
        MacroPiece(
            id=f"macro:{source}:ograf:{_slug(f'{pack or ""} {manifest.get("id") or member}')}",
            name=name,
            kind="ograf",
            source=source,  # type: ignore[arg-type]
            path=path,
            pack=pack,
            controls=tuple(controls),
        )
    ]


def _read_text(path: Path) -> str:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"larger than {MAX_FILE_BYTES} bytes, skipped")
    with path.open("rb") as handle:
        return handle.read().decode("utf-8", "replace")


def _scan_pack(path: Path, source: str, out: list[MacroPiece], errors: list[str]) -> None:
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        errors.append(f"{path}: not a readable pack ({error})")
        return
    with archive:
        for info in archive.infolist():
            lowered = info.filename.lower()
            if info.is_dir() or not lowered.endswith((".setting", ".ograf.json")):
                continue
            where = f"{path}!{info.filename}"
            if info.file_size > MAX_FILE_BYTES:
                errors.append(f"{where}: larger than {MAX_FILE_BYTES} bytes, skipped")
                continue
            try:
                text = archive.read(info).decode("utf-8", "replace")
                if lowered.endswith(".setting"):
                    kind = _kind_of(info.filename.split("/"))
                    out.extend(
                        _setting_pieces(
                            text, member=info.filename, kind=kind, source=source, path=where,
                            pack=path.name,
                        )
                    )
                else:
                    out.extend(
                        _ograf_pieces(
                            text, member=info.filename, source=source, path=where, pack=path.name
                        )
                    )
            except (OSError, ValueError, LuaTableError, zipfile.BadZipFile, RuntimeError) as error:
                errors.append(f"{where}: {error}")


def _scan_root(root: FusionRoot, out: list[MacroPiece], errors: list[str]) -> None:
    base, source = root.path, root.source
    seen: set[Path] = set()
    for folder, fallback in (("Templates", "macro"), ("Macros", "macro"), ("Ograf", "ograf")):
        start = base / folder
        if not start.is_dir():
            continue
        for path in _walk(start, ".setting", ".ograf.json", ".drfx"):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            name = path.name.lower()
            try:
                if name.endswith(".drfx"):
                    _scan_pack(path, source, out, errors)
                elif name.endswith(".ograf.json"):
                    out.extend(
                        _ograf_pieces(
                            _read_text(path), member=str(path.relative_to(base)), source=source,
                            path=str(path), pack=None,
                        )
                    )
                else:
                    kind = _kind_of(path.relative_to(base).parts, fallback)  # type: ignore[arg-type]
                    out.extend(
                        _setting_pieces(
                            _read_text(path), member=str(path.relative_to(base)), kind=kind,
                            source=source, path=str(path), pack=None,
                        )
                    )
            except (OSError, ValueError, LuaTableError) as error:
                errors.append(f"{path}: {error}")


def scan_fusion(roots: Sequence[FusionRoot] | None = None) -> ScanResult:
    """Scan every Fusion folder that exists. Never writes, never raises per file."""
    roots = fusion_roots() if roots is None else roots
    pieces: list[MacroPiece] = []
    errors: list[str] = []
    found = [str(root.path) for root in roots if root.path.is_dir()]
    for root in roots:
        if root.path.is_dir():
            _scan_root(root, pieces, errors)
    unique = {piece.id: piece for piece in pieces}
    return ScanResult(
        pieces=sorted(unique.values(), key=lambda p: (p.kind, p.name.lower(), p.id)),
        errors=errors,
        roots=found,
        scanned_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
