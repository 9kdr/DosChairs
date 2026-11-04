"""Effect Maker brain: Muse Spark writes effect specs, vision checks the look.

The editor describes a look (or drops a reference image) and the executor
model drafts an effect spec matching schemas/effect-spec.schema.json. The
spec previews in the browser (packages/effects) and exports to Resolve via
the Fusion exporter (#232). Nothing here touches the timeline: generated
specs are pending proposals until the editor accepts them.

Pipeline: generate (model draft + schema validate + one repair retry, then
a clear error) -> export target pick (fusion-macro when every layer maps to
the Fusion node set, ograf for live web shaders, rendered-clip otherwise)
-> verify (verifier vision compares the preview frame against the
reference/intent, max 2 rounds).
"""

import base64
import json
import os
import threading
import time
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict

from chair_agent.client import Message, ModelClient

SCHEMA_VERSION = "0.1.0"

# Layers the Fusion exporter (#232) can express with native nodes. Custom
# GLSL ships as a parameterized OGraf title instead (#234); anything else
# only survives as a pre-rendered clip.
FUSION_MAPPABLE_LAYERS = frozenset({"shape", "text", "image"})

FUSION_NODES = (
    "Background, Text+, Rectangle/Ellipse (mask or Background shape), "
    "Transform, Merge, Blur, SoftGlow, ColorCorrector, Loader"
)

RENDERABLE_LAYERS = (
    "shape (rect, ellipse), text (string, font, size, fill), "
    "image (src, Loader in Fusion), shader (custom GLSL ES 3.00 fragment, "
    "ships as a parameterized OGraf title with Inspector controls)"
)

TASTE_GUIDE = (
    "Motion-design taste guide: ease in and out with handles, never linear "
    "slides (linear reads as broken); overshoot and settle instead of easing "
    "to a dead stop; stagger layered entrances by 2-4 frames so the eye has "
    "an order to follow; keep type readable the whole way through (no tiny "
    "text, no long strings at speed); use glow with restraint (one SoftGlow "
    "peak, never stacked); keep contrast high enough to read over footage."
)

MAX_VERIFY_ROUNDS = 2


class InvalidEffect(ValueError):
    pass


_MODEL_ERROR_PREFIXES = (
    "effect generation needs a model",
    "effect verify needs a model",
    "effect model unavailable",
    "model call failed",
)


def error_status(error: InvalidEffect) -> int:
    """HTTP status for an effect failure: 404 unknown id, 502 model down, else 400."""
    message = str(error)
    if message.startswith("unknown effect"):
        return 404
    if message.startswith(_MODEL_ERROR_PREFIXES):
        return 502
    return 400


class EffectRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    spec: dict[str, Any]
    notes: str = ""
    verify_rounds: int = 0
    last_verdict: str | None = None


_STORE_LOCK = threading.Lock()
_EFFECTS: dict[str, EffectRecord] = {}
_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "generated": 0,
    "verify_passes": 0,
    "verify_fails": 0,
    "last_latency_ms": None,
    "last_error": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: effects generated, verify passes/fails, latency, error."""
    with _STATUS_LOCK:
        return dict(_STATUS)


def _note_generated(latency_ms: float, error: str | None = None) -> None:
    with _STATUS_LOCK:
        if error is None:
            _STATUS["generated"] += 1
        _STATUS["last_latency_ms"] = latency_ms
        _STATUS["last_error"] = error


def _note_verdict(passed: bool, latency_ms: float, error: str | None = None) -> None:
    with _STATUS_LOCK:
        if error is None:
            _STATUS["verify_passes" if passed else "verify_fails"] += 1
        _STATUS["last_latency_ms"] = latency_ms
        _STATUS["last_error"] = error


def _schema_path() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root:
        return Path(root) / "schemas" / "effect-spec.schema.json"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "schemas" / "effect-spec.schema.json"
        if candidate.is_file():
            return candidate
    raise InvalidEffect("schemas/effect-spec.schema.json not found")


def _load_schema() -> dict[str, Any]:
    try:
        return json.loads(_schema_path().read_text(encoding="utf-8"))
    except OSError as error:
        raise InvalidEffect(f"cannot read effect schema: {error}") from error


def _fixture_text() -> str:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    candidates = (
        [Path(root) / "fixtures" / "effects" / "bounce-title.effect.json"]
        if root
        else [p / "fixtures" / "effects" / "bounce-title.effect.json"
              for p in Path(__file__).resolve().parents]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8")
    return ""


def validate_effect_spec(data: Mapping[str, Any]) -> dict[str, Any]:
    """Validate raw model output against schemas/effect-spec.schema.json."""
    if not isinstance(data, Mapping):
        raise InvalidEffect("effect spec must be an object")
    schema = _load_schema()
    errors = list(Draft202012Validator(schema).iter_errors(dict(data)))
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.absolute_path) or "spec"
        raise InvalidEffect(f"invalid effect spec at {where}: {first.message}")
    return dict(data)


def pick_export_target(spec: Mapping[str, Any]) -> dict[str, Any]:
    """fusion-macro when every layer maps to the Fusion node set.

    Shader layers (custom GLSL) have no Fusion-node equivalent, but they do
    not need a baked clip either: they ship as a parameterized OGraf title
    whose controls land in the Inspector. The fallback says why in plain
    words. Anything else unmapped still falls back to rendered-clip.
    """
    layers = spec.get("layers")
    unmapped = sorted({
        str(layer.get("type", "?"))
        for layer in layers
        if isinstance(layer, Mapping) and layer.get("type") not in FUSION_MAPPABLE_LAYERS
    }) if isinstance(layers, list) else ["layers"]
    has_shader = isinstance(spec.get("shader"), Mapping) or "shader" in unmapped
    if not unmapped and not has_shader:
        return {"target": "fusion-macro"}
    if has_shader:
        return {
            "target": "ograf",
            "fallback": {
                "capability": "native Fusion nodes",
                "reason": (
                    "This effect is a live web shader (custom GLSL), which no "
                    f"Fusion node in ({FUSION_NODES}) can express, so it ships "
                    "as a parameterized OGraf title with its controls in the "
                    "Inspector instead of a pre-rendered clip."
                ),
            },
        }
    kinds = ", ".join(unmapped)
    return {
        "target": "rendered-clip",
        "fallback": {
            "capability": "native Fusion nodes",
            "reason": (
                f"This effect needs {kinds}, which no Fusion node in "
                f"({FUSION_NODES}) can express, so it ships as a "
                "pre-rendered clip with alpha instead of an editable macro."
            ),
        },
    }


def _image_part(reference_image: str) -> dict[str, Any] | None:
    """Normalize a data URL or file path into a chat image part."""
    value = (reference_image or "").strip()
    if not value:
        return None
    if value.startswith("data:"):
        return {"type": "image_url", "image_url": {"url": value}}
    path = Path(value).expanduser()
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise InvalidEffect(f"reference image unreadable: {value}: {error}") from error
    suffix = path.suffix.lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "webp": "image/webp", "gif": "image/gif"}.get(suffix.lstrip("."), "image/png")
    encoded = base64.b64encode(raw).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}}


def build_generate_messages(
    prompt: str,
    *,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
    rig: Mapping[str, Any] | None = None,
    reference_image: str | None = None,
) -> list[Message]:
    """Prompt carrying the schema, the sample fixture, and the taste guide."""
    if not prompt.strip():
        raise InvalidEffect("generate needs a non-empty 'prompt'")
    schema_text = json.dumps(_load_schema())
    developer_lines = [
        "You draft DaVinci Resolve effect specs (the Chair Effect Maker).",
        "Reply with ONE JSON object and nothing else: an effect spec matching "
        "this JSON schema exactly (schemaVersion must be \"0.1.0\", layers "
        "non-empty, every animated property as curves of time/value "
        "keyframes with easing):",
        schema_text,
        "A valid example (bounce-title) to copy the shape from:",
        _fixture_text() or "(fixture unavailable; follow the schema)",
        f"Renderable layer types: {RENDERABLE_LAYERS}.",
        f"Fusion macro node set the exporter supports: {FUSION_NODES}. "
        "Prefer shape/text/image layers so the effect stays an editable macro; "
        "reach for a shader layer only when the look truly needs custom GLSL.",
        TASTE_GUIDE,
        "Published controls: expose the 1-3 things an editor would retitle or "
        "recolor (text string, main color), each targeting a real layer param.",
        f"Canvas: {width}x{height}, {fps} fps, {duration_sec}s. Use exactly "
        "these numbers for width, height, fps, durationSec.",
    ]
    if rig is not None:
        developer_lines.append(
            "The editor keyed a rough motion path in Resolve; honor it via the "
            f"rig inputPath (do not invent a different path): {json.dumps(rig)}"
        )
    if reference_image:
        developer_lines.append(
            "A reference image is attached: match its layout, palette, and "
            "mood, but keep text legible and motion eased, not linear."
        )
    image_part = _image_part(reference_image or "")
    user_content: str | list[dict[str, Any]] = prompt.strip()
    if image_part is not None:
        user_content = [
            {"type": "text", "text": prompt.strip()},
            image_part,
        ]
    return [
        Message(role="developer", content="\n".join(developer_lines)),
        Message(role="user", content=user_content),
    ]


def _parse_spec_completion(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    try:
        payload = json.loads(trimmed)
    except json.JSONDecodeError as error:
        raise InvalidEffect(f"model did not return JSON: {error}") from error
    if not isinstance(payload, dict):
        raise InvalidEffect("model must return one JSON object, not a list or scalar")
    return payload


def build_repair_messages(
    bad_spec: Mapping[str, Any], errors: Sequence[str],
) -> list[Message]:
    reasons = "\n".join(f"- {error}" for error in errors) or "- (unknown reason)"
    return [
        Message(role="developer", content=(
            "You draft DaVinci Resolve effect specs. Your last draft failed "
            "schema validation. Reply with ONE fixed JSON object and nothing "
            "else, changing as little as possible while fixing every error:\n"
            f"{reasons}"
        )),
        Message(role="user", content=json.dumps(dict(bad_spec))),
    ]


def _model_client(role: str) -> ModelClient:
    from chair_agent.client import build_client, load_settings

    settings = load_settings()
    wanted = settings.models.executor if role == "generate" else settings.models.verifier
    need = "CHAIR_EXECUTOR_MODEL" if role == "generate" else "CHAIR_VERIFIER_MODEL"
    if not wanted or not settings.api_key:
        raise InvalidEffect(
            f"effect {role} needs a model: set META_API_KEY and "
            f"{need} (e.g. muse-spark-1)"
        )
    try:
        return build_client()
    except Exception as error:
        raise InvalidEffect(f"effect model unavailable: {error}") from error


def _state_dir(env: Mapping[str, str] | None = None) -> Path:
    source: Mapping[str, str] = os.environ if env is None else env
    root = (source.get("CHAIR_AGENT_STATE_DIR") or "").strip()
    base = Path(root).expanduser() if root else (
        Path.home() / ".local" / "share" / "chair" / "agent"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _store_path(env: Mapping[str, str] | None = None) -> Path:
    return _state_dir(env) / "effects.json"


def _save_store(env: Mapping[str, str] | None = None) -> None:
    try:
        with _STORE_LOCK:
            payload = {key: rec.model_dump(mode="json") for key, rec in _EFFECTS.items()}
        _store_path(env).write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass


def _load_store(env: Mapping[str, str] | None = None) -> None:
    try:
        raw = json.loads(_store_path(env).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(raw, dict):
        return
    with _STORE_LOCK:
        for key, item in raw.items():
            try:
                _EFFECTS[key] = EffectRecord.model_validate(item)
            except ValueError:
                continue


def get_effect(effect_id: str) -> EffectRecord:
    with _STORE_LOCK:
        record = _EFFECTS.get(effect_id)
    if record is None:
        _load_store()
        with _STORE_LOCK:
            record = _EFFECTS.get(effect_id)
    if record is None:
        raise InvalidEffect(f"unknown effect: {effect_id!r}")
    return record


def _register(record: EffectRecord, env: Mapping[str, str] | None = None) -> None:
    with _STORE_LOCK:
        _EFFECTS[record.id] = record
    _save_store(env)


def generate_effect(
    prompt: str,
    *,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
    rig: Mapping[str, Any] | None = None,
    reference_image: str | None = None,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
) -> EffectRecord:
    """Draft, validate (one repair retry), target, and store an effect spec."""
    if width <= 0 or height <= 0:
        raise InvalidEffect("canvas width and height must be positive integers")
    if fps <= 0 or duration_sec <= 0:
        raise InvalidEffect("fps and durationSec must be positive numbers")
    active = client if client is not None else _model_client("generate")
    messages = build_generate_messages(
        prompt, width=width, height=height, fps=fps,
        duration_sec=duration_sec, rig=rig, reference_image=reference_image,
    )
    started = time.perf_counter()
    notes = "Drafted by Muse Spark from the brief."
    if reference_image:
        notes += " A reference image guided the look."
    try:
        completion = active.execute(messages)
        draft = _parse_spec_completion(completion.text)
        try:
            spec = validate_effect_spec(draft)
        except InvalidEffect as first_error:
            repair = active.execute(
                build_repair_messages(draft, [str(first_error)])
            )
            draft = _parse_spec_completion(repair.text)
            try:
                spec = validate_effect_spec(draft)
            except InvalidEffect as second_error:
                raise InvalidEffect(
                    "model output failed validation twice; last error: "
                    f"{second_error}"
                ) from second_error
            notes += " First draft failed validation; repaired on retry."
        effect_id = f"fx-{uuid.uuid4().hex[:12]}"
        spec = dict(spec)
        spec["id"] = effect_id
        spec["width"] = width
        spec["height"] = height
        spec["fps"] = fps
        spec["durationSec"] = duration_sec
        spec["export"] = pick_export_target(spec)
        if rig is not None:
            spec["rig"] = dict(rig)
        record = EffectRecord(id=effect_id, spec=spec, notes=notes)
        _register(record, env)
    except InvalidEffect as error:
        _note_generated(round((time.perf_counter() - started) * 1000, 1), str(error))
        raise
    except Exception as error:
        _note_generated(
            round((time.perf_counter() - started) * 1000, 1),
            f"model call failed: {error}",
        )
        raise InvalidEffect(f"model call failed: {error}") from error
    _note_generated(round((time.perf_counter() - started) * 1000, 1))
    return record


def build_verify_messages(
    record: EffectRecord,
    *,
    preview_png: str,
    reference_png: str | None = None,
    resolve_still_png: str | None = None,
) -> list[Message]:
    """Vision prompt: compare the render against the reference and intent."""
    if not (preview_png or "").strip():
        raise InvalidEffect("verify needs a 'previewPng' (data URL or path)")
    parts: list[Any] = [
        {"type": "text", "text": (
            "You check Effect Maker renders. Compare the PREVIEW frame against "
            "the intent (effect brief below) and the REFERENCE image when one "
            "is attached. Against the RESOLVE STILL when attached, judge only "
            "whether the effect sits in the grade (exposure, contrast, "
            "saturation); never restyle the footage itself.\n"
            "Reply with ONE JSON object and nothing else: "
            '{"pass": <bool>, "notes": "<concrete differences or ok>", '
            '"revisedSpec": <full fixed spec object, or null>}. '
            "Pass when layout, palette, legibility, and motion endpoints match; "
            "fail on concrete mismatches only (wrong color, clipped text, "
            "linear motion, missing stagger, glow overdone). When you fail, "
            "return a revisedSpec: the input spec below with the smallest fix "
            "that closes the gap (same id, same canvas, same schema). "
            "List every difference in notes as short bullets."
        )},
        {"type": "text", "text": f"Effect brief notes: {record.notes}"},
        {"type": "text", "text": f"Current spec: {json.dumps(record.spec)}"},
        {"type": "text", "text": "PREVIEW frame:"},
    ]
    preview_part = _image_part(preview_png)
    if preview_part is not None:
        parts.append(preview_part)
    if (reference_png or "").strip():
        parts.append({"type": "text", "text": "REFERENCE image:"})
        reference_part = _image_part(reference_png or "")
        if reference_part is not None:
            parts.append(reference_part)
    if (resolve_still_png or "").strip():
        parts.append({"type": "text", "text": "RESOLVE STILL (grade context only):"})
        still_part = _image_part(resolve_still_png or "")
        if still_part is not None:
            parts.append(still_part)
    return [
        Message(role="developer", content=(
            "You are the Chair effect verifier: concrete visual differences, "
            "smallest fixing edit, JSON only."
        )),
        Message(role="user", content=parts),
    ]


def _parse_verdict(text: str) -> tuple[bool, str, dict[str, Any] | None]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    try:
        payload = json.loads(trimmed)
    except json.JSONDecodeError as error:
        raise InvalidEffect(f"verifier did not return JSON: {error}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("pass"), bool):
        raise InvalidEffect("verdict must be an object with a boolean 'pass'")
    notes = payload.get("notes")
    revised = payload.get("revisedSpec")
    if revised is not None and not isinstance(revised, dict):
        raise InvalidEffect("revisedSpec must be an object or null")
    return (
        bool(payload["pass"]),
        str(notes) if isinstance(notes, str) and notes.strip() else "",
        dict(revised) if isinstance(revised, dict) else None,
    )


def verify_effect(
    effect_id: str,
    *,
    preview_png: str,
    reference_png: str | None = None,
    resolve_still_png: str | None = None,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[EffectRecord, bool, str]:
    """Vision-check one render; on fail store the revised spec. Max 2 rounds."""
    record = get_effect(effect_id)
    if record.verify_rounds >= MAX_VERIFY_ROUNDS:
        raise InvalidEffect(
            f"effect {effect_id} already used its {MAX_VERIFY_ROUNDS} verify rounds"
        )
    active = client if client is not None else _model_client("verify")
    messages = build_verify_messages(
        record, preview_png=preview_png, reference_png=reference_png,
        resolve_still_png=resolve_still_png,
    )
    started = time.perf_counter()
    try:
        completion = active.verify(messages)
        passed, notes, revised = _parse_verdict(completion.text)
        updated = record.model_copy(update={
            "verify_rounds": record.verify_rounds + 1,
            "last_verdict": "pass" if passed else "fail",
        })
        if not passed and revised is not None:
            try:
                fixed = validate_effect_spec(revised)
            except InvalidEffect as error:
                raise InvalidEffect(
                    f"verifier's revised spec is invalid: {error}"
                ) from error
            fixed = dict(fixed)
            fixed["id"] = record.id
            fixed.setdefault("export", pick_export_target(fixed))
            updated = updated.model_copy(update={"spec": fixed})
            notes = notes or "Revised spec stored; re-render and verify again."
        elif not passed:
            notes = notes or "Preview differs from the intent; see notes, then re-render."
        else:
            notes = notes or "Preview matches the intent."
        _register(updated, env)
    except InvalidEffect as error:
        _note_verdict(False, round((time.perf_counter() - started) * 1000, 1), str(error))
        raise
    except Exception as error:
        _note_verdict(
            False, round((time.perf_counter() - started) * 1000, 1),
            f"model call failed: {error}",
        )
        raise InvalidEffect(f"model call failed: {error}") from error
    _note_verdict(passed, round((time.perf_counter() - started) * 1000, 1))
    return get_effect(effect_id), passed, notes
