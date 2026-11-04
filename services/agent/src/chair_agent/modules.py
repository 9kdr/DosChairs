"""Effect modules: Muse Wonder writes one TSX file, Chair bundles it for Resolve.

An effect module is a single TSX file (``meta``, ``props``, a default React
component that is a pure function of props and ``t``). The agent asks Muse
Wonder to write one from a brief, checks it (static scan, import allow-list,
and a locked-down probe that renders frames and seeks away and back), and
bundles it into an OGraf title whose props are Fusion Inspector controls.
Installing copies the title into Resolve's OGraf folder under a new versioned
name: an existing template is never overwritten.

Bundling and checking run in ``packages/effects`` (esbuild, react-dom/server);
this module drives that CLI. Nothing here touches the timeline.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from chair_agent.client import Message, ModelClient

DEFAULT_MODULE_MODEL = "muse-wonder-1.0"
MODEL_ENV = "CHAIR_MODULE_MODEL"
OGRAF_DIR_ENV = "CHAIR_OGRAF_DIR"
_CLI_TIMEOUT_SECONDS = 90
_MODEL_TIMEOUT_SECONDS = 240.0
_MAX_REFERENCE_CHARS = 6000
_MAX_REFERENCES = 5


class InvalidModule(ValueError):
    pass


_MODEL_ERROR_PREFIXES = (
    "module generation needs a model",
    "module model unavailable",
    "model call failed",
)


def error_status(error: InvalidModule) -> int:
    """HTTP status: 404 unknown id, 502 model down, 503 toolchain missing, else 400."""
    message = str(error)
    if message.startswith("unknown module"):
        return 404
    if message.startswith(_MODEL_ERROR_PREFIXES):
        return 502
    if message.startswith("module toolchain"):
        return 503
    return 400


class ModuleRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    brief: str = ""
    model: str | None = None
    source_path: str
    notes: str = ""
    repaired: bool = False
    meta: dict[str, Any] | None = None
    props: list[dict[str, Any]] = []
    checks: dict[str, Any] = {}
    warnings: list[str] = []
    stem: str | None = None
    build_dir: str | None = None
    files: list[str] = []
    installs: list[dict[str, Any]] = []


_STORE_LOCK = threading.Lock()
_MODULES: dict[str, ModuleRecord] = {}
_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "generated": 0,
    "repaired": 0,
    "generate_failures": 0,
    "bundled": 0,
    "bundle_failures": 0,
    "determinism_passes": 0,
    "determinism_failures": 0,
    "installed": 0,
    "last_generate_ms": None,
    "last_bundle_ms": None,
    "last_model": None,
    "last_error": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: generated/repaired/bundled/installed, determinism, times, last error."""
    with _STATUS_LOCK:
        snap = dict(_STATUS)
    with _STORE_LOCK:
        snap["stored"] = len(_MODULES)
    return snap


def reset_status() -> None:
    with _STATUS_LOCK:
        for key, value in list(_STATUS.items()):
            _STATUS[key] = 0 if isinstance(value, int) else None
    with _STORE_LOCK:
        _MODULES.clear()


def _bump(**counts: int) -> None:
    with _STATUS_LOCK:
        for key, n in counts.items():
            _STATUS[key] += n


def _note(**values: Any) -> None:
    with _STATUS_LOCK:
        _STATUS.update(values)


# --- paths and toolchain -----------------------------------------------------


def repo_root() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root and (Path(root) / "packages" / "effects" / "approved-imports.json").is_file():
        return Path(root)
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages" / "effects" / "approved-imports.json").is_file():
            return parent
    raise InvalidModule("module toolchain: packages/effects/approved-imports.json not found")


def _effects_dir() -> Path:
    return repo_root() / "packages" / "effects"


def _state_dir(env: Mapping[str, str] | None = None) -> Path:
    from chair_agent.effects import _state_dir as effects_state_dir

    base = effects_state_dir(env) / "modules"
    base.mkdir(parents=True, exist_ok=True)
    return base


def ograf_install_dir() -> Path:
    custom = os.environ.get(OGRAF_DIR_ENV, "").strip()
    if custom:
        return Path(custom).expanduser()
    return (
        Path.home() / ".local" / "share" / "DaVinciResolve" / "Fusion"
        / "Templates" / "Edit" / "Titles" / "OGraf"
    )


def load_catalogue() -> dict[str, Any]:
    return json.loads((_effects_dir() / "approved-imports.json").read_text(encoding="utf-8"))


def _newest_source_mtime() -> float:
    newest = 0.0
    roots = [
        _effects_dir() / "src" / "modules",
        _effects_dir() / "src" / "kit",
        repo_root() / "packages" / "ograf" / "src",
    ]
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in {".ts", ".tsx"}:
                newest = max(newest, path.stat().st_mtime)
    for extra in (
        _effects_dir() / "approved-imports.json",
        _effects_dir() / "src" / "gl.ts",
    ):
        if extra.is_file():
            newest = max(newest, extra.stat().st_mtime)
    return newest


def _cli_path() -> Path:
    """Build packages/effects/build/modules-cli.mjs when missing or stale."""
    effects = _effects_dir()
    out = effects / "build" / "modules-cli.mjs"
    if out.is_file() and out.stat().st_mtime >= _newest_source_mtime():
        return out
    esbuild = effects / "node_modules" / ".bin" / "esbuild"
    if not esbuild.exists():
        raise InvalidModule(
            "module toolchain: esbuild is not installed; run `mise run bootstrap`"
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    banner = (
        "import{createRequire as __cr}from'node:module';"
        "const require=__cr(import.meta.url);"
    )
    try:
        subprocess.run(
            [
                str(esbuild), "src/modules/cli.ts", "--bundle", "--platform=node",
                "--format=esm", f"--outfile={out}", "--external:esbuild",
                f"--banner:js={banner}", "--log-level=warning",
            ],
            cwd=effects, check=True, capture_output=True, text=True,
            timeout=_CLI_TIMEOUT_SECONDS,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        detail = getattr(error, "stderr", "") or str(error)
        raise InvalidModule(f"module toolchain: could not build the bundler: {detail}") from error
    return out


def run_cli(command: str, entry: Path, out_dir: Path | None = None) -> dict[str, Any]:
    """Run the effects CLI (check or bundle) and return its JSON result."""
    node = shutil.which("node")
    if node is None:
        raise InvalidModule("module toolchain: node is not on PATH; install it with mise")
    argv = [node, str(_cli_path()), command, str(entry)]
    if out_dir is not None:
        argv += ["--out", str(out_dir)]
    try:
        done = subprocess.run(
            argv, cwd=_effects_dir(), capture_output=True, text=True,
            timeout=_CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise InvalidModule("module toolchain: the bundler timed out") from error
    lines = [line for line in done.stdout.splitlines() if line.strip().startswith("{")]
    if not lines:
        raise InvalidModule(
            f"module toolchain: the bundler crashed: {done.stderr.strip()[:400]}"
        )
    return json.loads(lines[-1])


# --- prompt ------------------------------------------------------------------


def _example_sources() -> str:
    parts = []
    for name in ("expressive-mouse.tsx", "liquid-dither.tsx"):
        path = _effects_dir() / "modules" / name
        if path.is_file():
            parts.append(f"// ---- {name} ----\n{path.read_text(encoding='utf-8')}")
    return "\n\n".join(parts)


def catalogue_text(catalogue: Mapping[str, Any] | None = None) -> str:
    data = catalogue if catalogue is not None else load_catalogue()
    lines: list[str] = []
    for entry in data.get("imports", []):
        if entry.get("hidden"):
            continue
        lines.append(f"- {entry['name']}: {entry['summary']}")
        lines.extend(f"    {api}" for api in entry.get("api", []))
    return "\n".join(lines)


CONTRACT = """\
You write Chair effect modules: ONE TSX file that becomes a native DaVinci
Resolve (OGraf) title. Its props become Fusion Inspector controls the editor
can keyframe. The file must export exactly:

  export const meta = { id, name, kind: 'generator'|'overlay'|'rig'|'transition',
                        durationSec, fps, width, height };
  export const props = {     // each prop becomes an Inspector control
    targetX: { type: 'number', min: 0, max: 1920, default: 960, title: 'Mouse X' },
    accent:  { type: 'color', default: '#ff6a00', title: 'Accent' },  // '#rrggbb' color picker
    label:   { type: 'string', default: 'Hello', title: 'Text' },
    glow:    { type: 'boolean', default: true, title: 'Glow' },
  };
  export default function Effect({ t, frame, fps, width, height, history, ...props }) { ... }

Hard rules (a check renders your frames, seeks away and back, and rejects the file otherwise):
1. The frame is a PURE function of (props, history, t). Same t gives an identical frame, in any
   order. No Date, performance.now, Math.random (use mulberry32/hash2 from @chair/effects),
   requestAnimationFrame, setTimeout/setInterval, fetch/network, module-level mutable state,
   or reading refs during render. No useState/useEffect for animation.
2. `t` is seconds since the effect started; `frame` the frame number at `fps`.
3. Physics (springs, swing, tilt, overshoot, squash, ropes) must be re-simulated from 0..t at a
   fixed step from `history(name, tau)` (a prop's value at any earlier time). Use the helpers in
   @chair/effects (simulateFollower, simulateSpring, followProp, verletChain). Do not carry state.
4. Props: 1 to 20 (Fusion's limit). Give every number a min, max, and a default inside the range.
   Prefer numbers and colors: they are keyframable. Prop ids are plain identifiers and may not be
   t, frame, fps, width, height, history, data. Make every prop visibly change the frame.
5. Imports: ONLY the approved list below, as written. No relative imports, no other packages.
6. Fill the frame: position:absolute; inset:0 root, sized to width x height, transparent
   background for overlay/rig kinds. Colors arrive as lowercase '#rrggbb'.
7. Reply with ONE ```tsx code block containing the whole file and nothing else.

Approved imports:
"""


def _reference_blocks(
    references: Sequence[Any] | None, piece_ids: Sequence[str] | None
) -> list[str]:
    blocks: list[str] = []
    for ref in list(references or [])[:_MAX_REFERENCES]:
        if isinstance(ref, str):
            title, text = "reference", ref
        elif isinstance(ref, Mapping):
            title = str(ref.get("name") or ref.get("title") or "reference")
            text = str(ref.get("text") or ref.get("code") or ref.get("summary") or "")
        else:
            continue
        if text.strip():
            blocks.append(f"[{title}]\n{text.strip()[:_MAX_REFERENCE_CHARS]}")
    if piece_ids:
        from chair_agent.pieces.catalog import PIECES

        by_id = {piece.id: piece for piece in PIECES}
        for piece_id in list(piece_ids)[:_MAX_REFERENCES]:
            piece = by_id.get(str(piece_id))
            if piece is None:
                raise InvalidModule(f"unknown piece reference: {piece_id!r}")
            blocks.append(f"[piece {piece.id}] {piece.summary}")
    return blocks


def build_generate_messages(
    brief: str,
    *,
    kind: str | None = None,
    width: int = 1920,
    height: int = 1080,
    fps: float = 30,
    duration_sec: float = 8,
    references: Sequence[Any] | None = None,
    piece_ids: Sequence[str] | None = None,
) -> list[Message]:
    if not brief.strip():
        raise InvalidModule("generate needs a non-empty 'brief'")
    developer = [
        CONTRACT + catalogue_text(),
        "Two working reference modules to copy the shape from:\n" + _example_sources(),
        f"Canvas: {width}x{height}, {fps} fps, {duration_sec}s. Use exactly these numbers in meta."
        + (f" meta.kind must be '{kind}'." if kind else ""),
    ]
    blocks = _reference_blocks(references, piece_ids)
    if blocks:
        developer.append(
            "Reference material from the editor (adapt it, do not copy blindly):\n"
            + "\n\n".join(blocks)
        )
    return [
        Message(role="developer", content="\n\n".join(developer)),
        Message(role="user", content=brief.strip()),
    ]


def build_repair_messages(source: str, errors: Sequence[str]) -> list[Message]:
    reasons = "\n".join(f"- {error}" for error in errors) or "- (unknown reason)"
    return [
        Message(role="developer", content=(
            CONTRACT + catalogue_text() + "\n\nYour last file failed the check. "
            "Reply with ONE ```tsx block holding the whole fixed file, changing as "
            f"little as possible while fixing every error:\n{reasons}"
        )),
        Message(role="user", content=source),
    ]


_FENCE = re.compile(r"```(?:tsx|ts|jsx|js|typescript|javascript)?\s*\n(.*?)```", re.DOTALL)


def parse_code(text: str) -> str:
    """The module source from a model reply: the largest fenced block, else raw text."""
    blocks = _FENCE.findall(text)
    if blocks:
        return max(blocks, key=len).strip() + "\n"
    open_fence = re.search(r"```(?:tsx|ts|jsx|js)?\s*\n(.*)$", text, re.DOTALL)
    candidate = (open_fence.group(1) if open_fence else text).strip()
    if "export default" not in candidate:
        raise InvalidModule("model did not return a module file (no `export default`)")
    return candidate + "\n"


# --- model -------------------------------------------------------------------


def module_model(env: Mapping[str, str] | None = None) -> str:
    source: Mapping[str, str] = os.environ if env is None else env
    return (source.get(MODEL_ENV) or "").strip() or DEFAULT_MODULE_MODEL


def _model_client() -> ModelClient:
    import httpx

    from chair_agent.client import HttpxTransport, RoleModels, load_settings

    settings = load_settings()
    if not settings.api_key:
        raise InvalidModule(
            f"module generation needs a model: set META_API_KEY (and optionally {MODEL_ENV})"
        )
    try:
        return ModelClient(
            models=RoleModels(planner=None, executor=module_model(), verifier=None),
            transport=HttpxTransport(
                settings.base_url, client=httpx.Client(timeout=_MODEL_TIMEOUT_SECONDS)
            ),
            api_key=settings.api_key,
        )
    except Exception as error:
        raise InvalidModule(f"module model unavailable: {error}") from error


# --- store -------------------------------------------------------------------


def _record_path(module_id: str, env: Mapping[str, str] | None = None) -> Path:
    return _state_dir(env) / module_id / "record.json"


def _register(record: ModuleRecord, env: Mapping[str, str] | None = None) -> None:
    with _STORE_LOCK:
        _MODULES[record.id] = record
    try:
        _record_path(record.id, env).write_text(
            json.dumps(record.model_dump(mode="json")), encoding="utf-8"
        )
    except OSError:
        pass


def get_module(module_id: str) -> ModuleRecord:
    if not re.fullmatch(r"fxm-[0-9a-f]{12}", module_id or ""):
        raise InvalidModule(f"unknown module: {module_id!r}")
    with _STORE_LOCK:
        record = _MODULES.get(module_id)
    if record is None:
        try:
            raw = json.loads(_record_path(module_id).read_text(encoding="utf-8"))
            record = ModuleRecord.model_validate(raw)
        except (OSError, ValueError):
            record = None
        if record is not None:
            with _STORE_LOCK:
                _MODULES[module_id] = record
    if record is None:
        raise InvalidModule(f"unknown module: {module_id!r}")
    return record


def _apply_report(record: ModuleRecord, report: Mapping[str, Any]) -> ModuleRecord:
    return record.model_copy(update={
        "meta": report.get("meta"),
        "props": list(report.get("props") or []),
        "checks": dict(report.get("checks") or {}),
        "warnings": list(report.get("warnings") or []),
    })


def _count_check(report: Mapping[str, Any]) -> None:
    checks = report.get("checks") or {}
    if "deterministic" in checks:
        _bump(determinism_passes=1) if checks["deterministic"] else _bump(determinism_failures=1)


def _write_source(module_id: str, source: str, env: Mapping[str, str] | None = None) -> Path:
    folder = _state_dir(env) / module_id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "Effect.tsx"
    path.write_text(source, encoding="utf-8")
    return path


def _check_source(module_id: str, source: str, env: Mapping[str, str] | None) -> dict[str, Any]:
    path = _write_source(module_id, source, env)
    report = run_cli("check", path)["report"]
    _count_check(report)
    return report


def register_source(
    source: str,
    *,
    brief: str = "",
    env: Mapping[str, str] | None = None,
) -> ModuleRecord:
    """Store a hand-written module file and check it (no model involved)."""
    if "export default" not in source:
        raise InvalidModule("module source needs a default export")
    module_id = f"fxm-{uuid.uuid4().hex[:12]}"
    report = _check_source(module_id, source, env)
    if not report["ok"]:
        raise InvalidModule("module failed the check: " + "; ".join(report["errors"][:6]))
    record = _apply_report(
        ModuleRecord(
            id=module_id, brief=brief, source_path=str(_write_source(module_id, source, env)),
            notes="Imported from source; passed the check.",
        ),
        report,
    )
    _register(record, env)
    return record


def generate_module(
    brief: str,
    *,
    kind: str | None = None,
    width: int = 1920,
    height: int = 1080,
    fps: float = 30,
    duration_sec: float = 8,
    references: Sequence[Any] | None = None,
    piece_ids: Sequence[str] | None = None,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
) -> ModuleRecord:
    """Draft with Muse Wonder, check, repair once on any failure, then store."""
    if width <= 0 or height <= 0 or fps <= 0 or duration_sec <= 0:
        raise InvalidModule("canvas width, height, fps, and durationSec must be positive")
    active = client if client is not None else _model_client()
    model = getattr(getattr(active, "models", None), "executor", None) or module_model(env)
    messages = build_generate_messages(
        brief, kind=kind, width=width, height=height, fps=fps,
        duration_sec=duration_sec, references=references, piece_ids=piece_ids,
    )
    module_id = f"fxm-{uuid.uuid4().hex[:12]}"
    started = time.perf_counter()
    notes = f"Written by {model} from the brief."
    repaired = False
    try:
        completion = active.execute(messages)
        source = ""
        errors: list[str]
        try:
            source = parse_code(completion.text)
            report = _check_source(module_id, source, env)
            errors = [] if report["ok"] else list(report["errors"])
        except InvalidModule as parse_error:
            if str(parse_error).startswith("module toolchain"):
                raise
            report, errors = {}, [str(parse_error)]
            source = completion.text
        if errors:
            repaired = True
            retry = active.execute(build_repair_messages(source, errors))
            try:
                source = parse_code(retry.text)
                report = _check_source(module_id, source, env)
            except InvalidModule as second:
                if str(second).startswith("module toolchain"):
                    raise
                raise InvalidModule(
                    f"model output failed the check twice; last error: {second}"
                ) from second
            if not report["ok"]:
                raise InvalidModule(
                    "model output failed the check twice; last errors: "
                    + "; ".join(report["errors"][:6])
                )
            notes += " First draft failed the check; repaired on retry."
        record = _apply_report(
            ModuleRecord(
                id=module_id, brief=brief.strip(), model=model,
                source_path=str(_write_source(module_id, source, env)),
                notes=notes, repaired=repaired,
            ),
            report,
        )
        _register(record, env)
    except InvalidModule as error:
        _bump(generate_failures=1)
        _note(
            last_generate_ms=round((time.perf_counter() - started) * 1000, 1),
            last_error=str(error),
        )
        raise
    except Exception as error:
        _bump(generate_failures=1)
        _note(
            last_generate_ms=round((time.perf_counter() - started) * 1000, 1),
            last_error=f"model call failed: {error}",
        )
        raise InvalidModule(f"model call failed: {error}") from error
    _bump(generated=1, repaired=1 if repaired else 0)
    _note(
        last_generate_ms=round((time.perf_counter() - started) * 1000, 1),
        last_model=model, last_error=None,
    )
    return record


# --- bundle, preview, install ------------------------------------------------


def bundle_module(module_id: str, env: Mapping[str, str] | None = None) -> ModuleRecord:
    """Bundle into <state>/modules/<id>/build/<stem>.ograf.json + <stem>.js."""
    record = get_module(module_id)
    build_dir = _state_dir(env) / module_id / "build"
    if build_dir.exists():
        shutil.rmtree(build_dir)
    started = time.perf_counter()
    try:
        result = run_cli("bundle", Path(record.source_path), build_dir)
    except InvalidModule as error:
        _bump(bundle_failures=1)
        _note(last_error=str(error))
        raise
    report = result["report"]
    _count_check(report)
    _note(last_bundle_ms=round((time.perf_counter() - started) * 1000, 1))
    if not report["ok"] or not result.get("id"):
        message = "module failed the check: " + "; ".join(report["errors"][:6])
        _bump(bundle_failures=1)
        _note(last_error=message)
        raise InvalidModule(message)
    updated = _apply_report(record, report).model_copy(update={
        "stem": result["id"], "build_dir": str(build_dir), "files": list(result["files"]),
    })
    _register(updated, env)
    _bump(bundled=1)
    _note(last_error=None)
    return updated


def build_file(module_id: str, name: str) -> Path:
    """A built file by bare name (preview and the desktop load the same bundle)."""
    record = get_module(module_id)
    if record.build_dir is None or "/" in name or name.startswith("."):
        raise InvalidModule(f"unknown module file: {name!r}")
    path = Path(record.build_dir) / name
    if not path.is_file():
        raise InvalidModule(f"unknown module file: {name!r}")
    return path


def _preview_template() -> str:
    return (Path(__file__).parent / "module_preview.html").read_text(encoding="utf-8")


def preview_html(
    stem: str, *, title: str, width: int, height: int, fps: float, duration_sec: float,
    js_url: str | None = None,
) -> str:
    """The page that loads a built bundle through the real OGraf lifecycle.

    Query: ``t`` seconds, ``props`` JSON, ``schedule`` JSON (OGraf events),
    ``check=a,b`` (seek a, b, a and report whether the frames match), ``shot``.
    """
    return (
        _preview_template().replace("__JS__", js_url or f"./{stem}.js")
        .replace("__TITLE__", title.replace("<", ""))
        .replace("__W__", str(int(width)))
        .replace("__H__", str(int(height)))
        .replace("__FPS__", str(fps))
        .replace("__DUR__", str(duration_sec))
    )


def preview_for(module_id: str) -> str:
    record = get_module(module_id)
    if record.stem is None or record.meta is None:
        raise InvalidModule(
            f"module {module_id} is not bundled yet; POST /effects/modules/{module_id}/bundle"
        )
    meta = record.meta
    return preview_html(
        record.stem, title=str(meta.get("name", record.stem)),
        width=int(meta.get("width", 1920)), height=int(meta.get("height", 1080)),
        fps=float(meta.get("fps", 30)), duration_sec=float(meta.get("durationSec", 5)),
        js_url=f"files/{record.stem}.js",
    )


def _free_stem(folder: Path, stem: str) -> tuple[str, int]:
    """First of stem, stem-v2, stem-v3 ... with no file of that name in folder."""
    def taken(candidate: str) -> bool:
        return any(
            (folder / f"{candidate}{suffix}").exists()
            for suffix in (".ograf.json", ".js", ".ograf")
        )

    if not taken(stem):
        return stem, 1
    version = 2
    while taken(f"{stem}-v{version}"):
        version += 1
    return f"{stem}-v{version}", version


def install_module(
    module_id: str, dest: Path | str | None = None, env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Copy the built title into Resolve's OGraf folder under a free versioned name.

    Never overwrites: when ``chair-<slug>`` already exists there, the copy is
    installed as ``chair-<slug>-v2`` (then v3, ...), with its manifest id,
    main, and display name updated to match. Needs a bundle first.
    """
    record = get_module(module_id)
    if record.stem is None or record.build_dir is None:
        raise InvalidModule(
            f"module {module_id} is not bundled yet; POST /effects/modules/{module_id}/bundle"
        )
    build = Path(record.build_dir)
    manifest = json.loads((build / f"{record.stem}.ograf.json").read_text(encoding="utf-8"))
    js = (build / f"{record.stem}.js").read_text(encoding="utf-8")
    folder = Path(dest).expanduser() if dest is not None else ograf_install_dir()
    folder.mkdir(parents=True, exist_ok=True)
    stem, version = _free_stem(folder, record.stem)
    if stem != record.stem:
        manifest["id"] = stem
        manifest["main"] = f"{stem}.js"
        manifest["name"] = f"{manifest.get('name', stem)} v{version}"
    manifest_path = folder / f"{stem}.ograf.json"
    js_path = folder / f"{stem}.js"
    # "x" mode: a race with another writer fails loudly instead of overwriting.
    try:
        with manifest_path.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(manifest, indent=2) + "\n")
        with js_path.open("x", encoding="utf-8") as handle:
            handle.write(js)
    except FileExistsError as error:
        raise InvalidModule(
            f"refusing to overwrite an existing template: {error.filename}"
        ) from error
    install = {
        "title_name": str(manifest["name"]), "stem": stem, "version": version,
        "dir": str(folder), "files": [str(manifest_path), str(js_path)],
        "renamed": stem != record.stem,
        "fallback": (
            "Resolve loads OGraf titles on macOS and Windows only; on Linux copy "
            "the folder to a Mac or Windows install."
        ),
    }
    _register(record.model_copy(update={"installs": [*record.installs, install]}), env)
    _bump(installed=1)
    return install
