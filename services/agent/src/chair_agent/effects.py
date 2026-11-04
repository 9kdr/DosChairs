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
from chair_agent.modules import scope_from_brief

SCHEMA_VERSION = "0.1.0"

# Layers the Fusion exporter (#232) can express with native nodes. Custom
# GLSL ships as a parameterized OGraf title instead (#234); anything else
# only survives as a pre-rendered clip. A shader layer tagged with a native
# look (params.look, see NATIVE_SHADER_LOOKS) also stays native (#256).
FUSION_MAPPABLE_LAYERS = frozenset({"shape", "text", "image"})

NATIVE_SHADER_LOOKS = frozenset(
    {"film-grain", "dither", "halftone", "fast-noise", "gradient", "glow"}
)

FUSION_NODES = (
    "Background, Text+, Rectangle/Ellipse (mask or Background shape), "
    "Transform, Merge, Blur, SoftGlow, ColorCorrector, Loader, FilmGrain, "
    "Custom (ordered-dither/halftone expressions), FastNoise, "
    "Background gradient mode"
)

RENDERABLE_LAYERS = (
    "shape (rect, ellipse), text (string, font, size, fill), "
    "image (src, Loader in Fusion), shader (custom GLSL ES 3.00 fragment, "
    "ships as a parameterized OGraf title with Inspector controls)"
)

TASTE_GUIDE = (
    "Motion-design taste guide, in the spirit of modern web studios (Unicorn "
    "Studio): shader-gradient washes, dithering and halftone texture, film "
    "grain, one restrained glow peak, liquid distortion saved for "
    "transitions. Ease in and out with handles, never linear slides (linear "
    "reads as broken); overshoot and settle instead of easing to a dead "
    "stop; stagger layered entrances by 2-4 frames so the eye has an order "
    "to follow; keep type readable the whole way through (no tiny text, no "
    "long strings at speed); keep contrast high enough to read over "
    "footage. Stay inside the renderable layer types and the Fusion node "
    "set above: reach the web look with shape/text/image layers plus Blur, "
    "SoftGlow, and ColorCorrector, and use a shader layer only when the "
    "look truly needs custom GLSL."
)

SCOPE_GUIDE = (
    "Scope: render ONLY the element the prompt asked for, on a TRANSPARENT "
    "background by default. The spec composites over the editor's footage, "
    "so never add a full-frame backdrop rect, plate, or fill unless the "
    "prompt asks for a background. No text unless the prompt asks for text "
    "or gives the exact string; a cursor or pointer the prompt names is one "
    "small glyph layer, not a label. No extra props, buttons, labels, or "
    "frames the prompt did not ask for. A deterministic check drops "
    "full-frame backdrops and unasked text after generation."
)

MAX_VERIFY_ROUNDS = 2
MAX_GENERATE_REPAIRS = 2


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
    "repairs": 0,
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


def _note_repair() -> None:
    with _STATUS_LOCK:
        _STATUS["repairs"] += 1


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


def _shader_look(layer: Mapping[str, Any]) -> str | None:
    """The native look a shader layer is tagged with, else None."""
    params = layer.get("params")
    look = params.get("look") if isinstance(params, Mapping) else None
    return look if isinstance(look, str) and look in NATIVE_SHADER_LOOKS else None


def pick_export_target(spec: Mapping[str, Any]) -> dict[str, Any]:
    """fusion-macro when every layer maps to the Fusion node set.

    Shader layers (custom GLSL) have no Fusion-node equivalent, but they do
    not need a baked clip either: a layer tagged with a native look
    (params.look) stays a keyframable Fusion macro, and any other custom
    shader ships as a parameterized OGraf title whose controls land in the
    Inspector. The fallback says why in plain words. Anything else unmapped
    still falls back to rendered-clip.
    """
    layers = spec.get("layers")
    unmapped: set[str] = set()
    if isinstance(layers, list):
        for layer in layers:
            if not isinstance(layer, Mapping):
                continue
            if layer.get("type") in FUSION_MAPPABLE_LAYERS:
                continue
            if layer.get("type") == "shader" and _shader_look(layer) is not None:
                continue
            unmapped.add(str(layer.get("type", "?")))
    else:
        unmapped.add("layers")
    unmapped = sorted(unmapped)
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


# A shape covering this fraction of the canvas reads as a backdrop.
_BACKDROP_COVERAGE = 0.9
_BACKDROP_OPACITY = 0.9


def _layer_numbers(layer: Mapping[str, Any], key: str) -> list[float]:
    """Every static or keyframed value a layer gives one property."""
    values: list[float] = []
    params = layer.get("params")
    if isinstance(params, Mapping):
        value = params.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values.append(float(value))
    curves = layer.get("curves")
    if isinstance(curves, Mapping):
        curve = curves.get(key)
        frames = curve.get("keyframes") if isinstance(curve, Mapping) else None
        if isinstance(frames, list):
            for frame in frames:
                value = frame.get("value") if isinstance(frame, Mapping) else None
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    values.append(float(value))
    return values


def _layer_extent(layer: Mapping[str, Any], key: str) -> float:
    """Largest static or keyframed size; 0 when the layer never says."""
    return max(_layer_numbers(layer, key), default=0.0)


def _layer_opacity(layer: Mapping[str, Any]) -> float:
    """Peak opacity; a layer that never mentions it is fully opaque."""
    return max(_layer_numbers(layer, "opacity"), default=1.0)


def _is_full_frame_backdrop(layer: Mapping[str, Any], width: int, height: int) -> bool:
    if layer.get("type") != "shape" or width <= 0 or height <= 0:
        return False
    covers = (
        _layer_extent(layer, "scaleX") >= _BACKDROP_COVERAGE * width
        and _layer_extent(layer, "scaleY") >= _BACKDROP_COVERAGE * height
    )
    return covers and _layer_opacity(layer) >= _BACKDROP_OPACITY


def _rig_target_id(spec: Mapping[str, Any]) -> str | None:
    """First layer already animating x or y: the rig's subject.

    Mirrors the desktop's rigTargetId (effect-model.ts): the layer the baked
    rig keys land on. The guard never drops it.
    """
    layers = spec.get("layers")
    if not isinstance(layers, list):
        return None
    for layer in layers:
        if not isinstance(layer, Mapping):
            continue
        curves = layer.get("curves")
        if isinstance(curves, Mapping) and ("x" in curves or "y" in curves):
            layer_id = layer.get("id")
            return str(layer_id) if isinstance(layer_id, str) and layer_id else None
    return None


def _unasked_string(
    layer: Mapping[str, Any], prompt: str, wants_text: bool,
) -> str | None:
    """The offending string when a text layer is neither asked for nor a glyph."""
    if layer.get("type") != "text" or wants_text:
        return None
    params = layer.get("params")
    string = params.get("string") if isinstance(params, Mapping) else None
    if not isinstance(string, str) or not string.strip():
        return None
    trimmed = string.strip()
    if len(trimmed) == 1:
        # A lone glyph (cursor arrow, dot) is drawn, not written; a lone
        # letter is never "asked for" by sharing one character.
        return None if not trimmed.isalnum() else trimmed
    if trimmed.lower() in prompt.lower():
        return None
    return trimmed


def apply_prompt_scope(spec: dict[str, Any], prompt: str) -> list[str]:
    """Drop layers the prompt never asked for: backdrops and stray text (#278).

    The model likes to dress the stage (a backdrop rect, a demo button with a
    label); in Resolve that paint covers the footage, so the guard removes it
    deterministically after generation. Scope words come from the module
    path's scope_from_brief, so both paths agree on what "asked for" means.
    The rig's subject layer always stays, the rig block is untouched, and
    controls left pointing at dropped layers go with them. Returns one human
    note per removal for the record.
    """
    scope = scope_from_brief(prompt or "")
    layers = spec.get("layers")
    if not isinstance(layers, list):
        return []
    width = spec.get("width")
    height = spec.get("height")
    canvas = (
        int(width) if isinstance(width, (int, float)) else 0,
        int(height) if isinstance(height, (int, float)) else 0,
    )
    rig = spec.get("rig")
    has_rig = isinstance(rig, Mapping) and bool(rig.get("inputPath"))
    target_id = _rig_target_id(spec) if has_rig else None
    dropped: list[str] = []
    dropped_ids: set[str] = set()
    kept: list[Any] = []
    for layer in layers:
        if not isinstance(layer, Mapping):
            kept.append(layer)
            continue
        layer_id = str(layer.get("id", "?"))
        if target_id is not None and layer.get("id") == target_id:
            kept.append(layer)
            continue
        if not scope["wantsBackground"] and _is_full_frame_backdrop(
            layer, canvas[0], canvas[1]
        ):
            dropped.append(f"{layer_id} (full-frame backdrop the prompt didn't ask for)")
            dropped_ids.add(layer_id)
            continue
        string = _unasked_string(layer, prompt or "", scope["wantsText"])
        if string is not None:
            dropped.append(f"{layer_id} (unasked text {string!r})")
            dropped_ids.add(layer_id)
            continue
        kept.append(layer)
    if not dropped or not kept:
        # Nothing to remove, or every layer looked unasked: leave the spec
        # whole rather than ship an empty stage.
        return []
    spec["layers"] = kept
    controls = spec.get("controls")
    if isinstance(controls, list):
        live = [
            control for control in controls
            if not (
                isinstance(control, Mapping)
                and isinstance(control.get("target"), Mapping)
                and control.get("target", {}).get("layerId") in dropped_ids
            )
        ]
        for control in controls:
            if control not in live:
                target = control.get("target", {}) if isinstance(control, Mapping) else {}
                dropped.append(
                    f"control {control.get('id', '?')!r} "
                    f"(target layer {target.get('layerId', '?')!r} was dropped)"
                )
        spec["controls"] = live
    return dropped


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
    references: Sequence[Mapping[str, Any]] | None = None,
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
        "for film grain, ordered dither, halftone dots, animated noise, a "
        "gradient wash, or a glow wash, use a shader layer tagged with "
        "params.look (film-grain, dither, halftone, fast-noise, gradient, "
        "glow) plus its look params (grain amount/size, dither levels, "
        "halftone cell/angle, noise detail/contrast, gradient colors, glow "
        "gain), which stays keyframable Fusion nodes; reach for untagged "
        "custom GLSL only when the look truly needs it.",
        TASTE_GUIDE,
        SCOPE_GUIDE,
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
    if references:
        from chair_agent.pieces.macros import references_note

        note = references_note(list(references))
        if note:
            developer_lines.append(note)
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
    bad_spec: Mapping[str, Any] | str, errors: Sequence[str],
) -> list[Message]:
    reasons = "\n".join(f"- {error}" for error in errors) or "- (unknown reason)"
    if isinstance(bad_spec, str):
        developer = (
            "You draft DaVinci Resolve effect specs. Your last draft was not "
            "valid JSON. Reply with ONE fixed JSON object and nothing else, "
            "changing as little as possible while fixing every error:\n"
            f"{reasons}"
        )
        user_content = bad_spec
    else:
        developer = (
            "You draft DaVinci Resolve effect specs. Your last draft failed "
            "schema validation. Reply with ONE fixed JSON object and nothing "
            "else, changing as little as possible while fixing every error:\n"
            f"{reasons}"
        )
        user_content = json.dumps(dict(bad_spec))
    return [
        Message(role="developer", content=developer),
        Message(role="user", content=user_content),
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
    references: Sequence[Mapping[str, Any]] | None = None,
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
        references=references,
    )
    started = time.perf_counter()
    notes = "Drafted by Muse Spark from the brief."
    if reference_image:
        notes += " A reference image guided the look."
    try:
        completion = active.execute(messages)
        text = completion.text
        parsed: dict[str, Any] | None = None
        malformed = False
        errors: list[str] = []
        repairs = 0
        while True:
            try:
                parsed = _parse_spec_completion(text)
                spec = validate_effect_spec(parsed)
                break
            except InvalidEffect as error:
                errors.append(str(error))
                if repairs >= MAX_GENERATE_REPAIRS:
                    raise InvalidEffect(
                        "model output failed validation "
                        f"{MAX_GENERATE_REPAIRS + 1} times; last error: {error}"
                    ) from error
                repairs += 1
                _note_repair()
                bad: Mapping[str, Any] | str = parsed if parsed is not None else text
                malformed = malformed or isinstance(bad, str)
                # The validator's own words go back in, verbatim.
                repair = active.execute(build_repair_messages(bad, list(errors)))
                text = repair.text
                parsed = None
        if repairs:
            if malformed:
                notes += " First draft was malformed JSON; repaired on retry."
            else:
                notes += " First draft failed validation; repaired on retry."
        effect_id = f"fx-{uuid.uuid4().hex[:12]}"
        spec = dict(spec)
        spec["id"] = effect_id
        spec["width"] = width
        spec["height"] = height
        spec["fps"] = fps
        spec["durationSec"] = duration_sec
        if rig is not None:
            spec["rig"] = dict(rig)
        dropped = apply_prompt_scope(spec, prompt)
        if dropped:
            notes += " Scope guard removed " + "; ".join(dropped) + "."
        spec["export"] = pick_export_target(spec)
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
