"""Effect spec to native Fusion comp/macro text for DaVinci Resolve Studio.

Pure serializer: an effect spec (schemas/effect-spec.schema.json) becomes
Fusion .comp text for TimelineItem.ImportFusionComp, or a MacroOperator
.setting for the Fusion Templates/Edit/Titles folder. No Resolve calls here.

spec_to_plan renders the same node graph as data (tools, inputs,
connections, animated inputs) for the API builder in fusion_build, which
is the default path now that ImportFusionComp ingests nothing on
Studio 21.1 (see #266). The .comp text stays for the opt-in fast path.

Spike facts baked in (files in /tmp/chair-spike/, tested on Mel's Studio):
- ImportFusionComp adds a NEW comp version; the original stays byte-identical.
- Scalar BezierSpline keyframes (Angle, Size, Blend) survive import.
- A Point input (Center) written as a direct BezierSpline was DROPPED, so
  animated points go through an XYPath modifier with separate X and Y
  BezierSplines, which is the reliable shape.
- A .setting in Fusion/Templates/Edit/Titles is picked up by template scan.

Coordinate mapping (documented so the live smoke can confirm by eye):
- Spec pixels, top-left origin, become Fusion 0..1 with a Y flip:
  nx = x / width, ny = 1 - y / height. Fusion is Y-up.
- Shape scaleX/scaleY are PIXEL sizes and land on the Rectangle/Ellipse
  mask Width/Height as frame fractions. Text size in px becomes TextPlus
  Size as a fraction of frame height. Image scaleX/scaleY are multipliers.
- Spec curve time in seconds becomes frame numbers: round(time * fps).
- Bezier inHandle/outHandle [dtSec, dv] become LH/RH {dtSec*fps, dv}.
- Linear keys carry Flags = { Linear = true }; hold keys carry
  Flags = { StepIn = true } (best effort, confirmed by the smoke test).

Anything this node set cannot express is NOT faked. A shader layer
names a native look via params["look"] (film-grain, dither, halftone,
fast-noise, gradient, glow) and becomes real Fusion tools with keyframable
controls. Any other shader layer needs a pre-baked PNG sequence passed as
sequences={layer_id: {"files": [...]}} and loads it through a Loader; with
neither, spec_to_comp / spec_to_macro return
{"fallback": {"capability": "fusionMacro", "reason": ...}} so the caller
falls back to a rendered clip.
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path
from typing import Any

FALLBACK_CAPABILITY = "fusionMacro"
FUSION_VERSION = "DaVinci Resolve Studio 21.1.0.0017"

# Layer types with a native node mapping. "shader" maps only when the
# layer names a native look (see NATIVE_SHADER_LOOKS) or ships a baked
# sequence; anything else falls back.
NATIVE_LAYER_TYPES = frozenset({"shape", "text", "image", "shader"})
SHAPE_KINDS = {"rect": "Rectangle", "ellipse": "Ellipse"}
FX_KINDS = frozenset({"blur", "glow", "grade"})
# Shader-layer looks with a native Fusion node mapping. The model tags one
# via params["look"]; any other shader layer needs a baked PNG sequence
# (sequences=...) or falls back. Input IDs were read live off Studio 21.1.
NATIVE_SHADER_LOOKS = frozenset(
    {"film-grain", "dither", "halftone", "fast-noise", "gradient", "glow"}
)
BLEND_MODES = {"normal": "Normal", "add": "Add", "multiply": "Multiply", "screen": "Screen"}
GENERIC_FONTS = {
    "sans-serif": "DejaVu Sans",
    "serif": "DejaVu Serif",
    "monospace": "DejaVu Sans Mono",
}

_OS_TITLE_PATHS = {
    "linux": ".local/share/DaVinciResolve/Fusion/Templates/Edit/Titles",
    "darwin": (
        "Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Titles"
    ),
}


def chair_cache_dir() -> Path:
    """Chair's comp cache. Never next to source media."""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "chair" / "fusion"


def title_template_dir(root: Path | None = None) -> Path:
    """Per-OS Fusion Templates/Edit/Titles folder (overridable for tests)."""
    if root is not None:
        return Path(root)
    if os.name == "nt":
        appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming"))
        return appdata / "Blackmagic Design/DaVinci Resolve/Support/Fusion/Templates/Edit/Titles"
    key = "darwin" if sys.platform == "darwin" else "linux"
    return Path.home() / _OS_TITLE_PATHS[key]


def _sequence_files(
    sequences: dict[str, Any] | None, layer_id: str
) -> list[str] | None:
    """PNG sequence files covering a shader layer, else None."""
    if not sequences:
        return None
    entry = sequences.get(layer_id)
    if not isinstance(entry, dict):
        return None
    files = entry.get("files")
    if not isinstance(files, list) or not files:
        return None
    paths = [str(path) for path in files if str(path).strip()]
    return paths or None


def check_spec(
    spec: dict[str, Any], sequences: dict[str, Any] | None = None
) -> list[str]:
    """Reasons the spec cannot become a Fusion macro. Empty means expressible.

    A shader layer passes when it names a native look via params["look"]
    or when sequences= covers it with a baked PNG sequence.
    """
    reasons: list[str] = []
    if not isinstance(spec, dict):
        return ["effect spec must be an object"]
    layers = spec.get("layers")
    if not isinstance(layers, list) or not layers:
        return ["effect spec has no layers"]
    for layer in layers:
        if not isinstance(layer, dict):
            reasons.append("a layer is not an object")
            continue
        lid = str(layer.get("id") or "?")
        ltype = layer.get("type")
        if ltype == "shader":
            look = (layer.get("params") or {}).get("look")
            if look in NATIVE_SHADER_LOOKS:
                reasons.extend(_check_look(layer, str(look)))
            elif _sequence_files(sequences, lid) is not None:
                continue
            else:
                reasons.append(
                    f"layer {lid!r}: a GLSL shader layer has no Fusion node "
                    "mapping (tag params.look with film-grain, dither, "
                    "halftone, fast-noise, gradient, or glow); bake the web "
                    "render to a PNG sequence and pass it as sequences={...}"
                )
            continue
        if ltype not in NATIVE_LAYER_TYPES:
            reasons.append(f"layer {lid!r}: unknown layer type {ltype!r}")
            continue
        params = layer.get("params") or {}
        if ltype == "shape" and params.get("kind", "rect") not in SHAPE_KINDS:
            reasons.append(
                f"layer {lid!r}: shape kind {params.get('kind')!r} is not rect or ellipse"
            )
        fx = _fx_list(params)
        for entry in fx:
            if entry.get("kind") not in FX_KINDS:
                reasons.append(f"layer {lid!r}: fx {entry.get('kind')!r} has no Fusion tool")
    return reasons


def _curve_min(curve: Any) -> float | None:
    """Smallest keyframe value in a curve, else None when there are no keys."""
    if not isinstance(curve, dict):
        return None
    keys = curve.get("keyframes")
    if not isinstance(keys, list) or not keys:
        return None
    values = [k["value"] for k in keys if isinstance(k, dict)]
    numbers = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return min(numbers) if numbers else None


def _check_look(layer: dict[str, Any], look: str) -> list[str]:
    """Validate one native-look shader layer's params. Empty means mappable."""
    lid = str(layer.get("id") or "?")
    params = layer.get("params")
    if not isinstance(params, dict):
        return [f"layer {lid!r}: look {look!r} needs a params object"]
    if look == "dither":
        levels = params.get("levels", 4)
        if isinstance(levels, bool) or not isinstance(levels, (int, float)) or levels < 2:
            return [f"layer {lid!r}: dither levels must be a number >= 2"]
        floor = _curve_min((layer.get("curves") or {}).get("levels"))
        if floor is not None and floor < 2:
            return [f"layer {lid!r}: dither levels keys must stay >= 2"]
    if look == "gradient":
        colors = params.get("colors")
        if not isinstance(colors, list) or len(colors) != 2:
            return [f"layer {lid!r}: gradient needs params.colors as [top, bottom] hex"]
        try:
            _hex_to_rgb(str(colors[0]))
            _hex_to_rgb(str(colors[1]))
        except ValueError:
            return [f"layer {lid!r}: gradient colors must be #rgb or #rrggbb"]
    return []


def spec_to_comp(
    spec: dict[str, Any],
    baked: dict[str, dict[str, list[dict[str, Any]]]] | None = None,
    media: dict[str, Any] | None = None,
    sequences: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render spec to ImportFusionComp text, or a fusionMacro fallback.

    baked maps layer id -> prop ("x", "y", "rotation", "scale") -> key list
    of {"time", "value"} (rig sim output or reduced keys); it overrides the
    layer's own curves for those props. media optionally carries
    {"path", "name", "width", "height", "frames"} for the MediaIn Loader.
    sequences maps a shader layer id -> {"files": [png, ...]}: the layer's
    pre-baked web render, loaded through a Loader node.
    On success the return carries "paths": layer id -> which node or Loader
    the layer took, for the report.
    """
    reasons = check_spec(spec, sequences)
    if reasons:
        return {
            "fallback": {
                "capability": FALLBACK_CAPABILITY,
                "reason": "; ".join(reasons),
            }
        }
    graph = _Graph(spec, baked or {}, sequences or {})
    tools = graph.comp_tools(media)
    return {"text": _composition(spec, tools), "paths": dict(graph.paths)}


def spec_to_plan(
    spec: dict[str, Any],
    baked: dict[str, dict[str, list[dict[str, Any]]]] | None = None,
    media: dict[str, Any] | None = None,
    sequences: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render spec to a node-graph plan for the API builder, or a fallback.

    Same inputs as spec_to_comp (media is accepted for parity but unused:
    the builder wires the clip's own MediaIn, already bound to footage).
    On success the return carries "tools": one entry per node in build
    order, each with name, AddTool registry id ("tool"), layer, role,
    values, gradient stops, connect, and splines, plus "paths" as in
    spec_to_comp.
    """
    reasons = check_spec(spec, sequences)
    if reasons:
        return {
            "fallback": {
                "capability": FALLBACK_CAPABILITY,
                "reason": "; ".join(reasons),
            }
        }
    graph = _Graph(spec, baked or {}, sequences or {}, record=[])
    graph.comp_tools(media)
    assert graph.record is not None
    return {"tools": graph.record, "paths": dict(graph.paths)}


def spec_to_macro(spec: dict[str, Any]) -> dict[str, Any]:
    """Render spec to a title-template MacroOperator .setting, or a fallback."""
    reasons = check_spec(spec)
    if reasons:
        return {
            "fallback": {
                "capability": FALLBACK_CAPABILITY,
                "reason": "; ".join(reasons),
            }
        }
    for layer in spec.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("type") != "shader":
            continue
        look = (layer.get("params") or {}).get("look")
        if look in _Graph.NEEDS_FOOTAGE:
            return {
                "fallback": {
                    "capability": FALLBACK_CAPABILITY,
                    "reason": (
                        f"layer {layer.get('id')!r}: look {look!r} processes "
                        "footage, and a title template has no footage input"
                    ),
                }
            }
    graph = _Graph(spec, {}, {})
    tools = graph.macro_tools()
    published, skipped = _published_controls(spec, graph)
    body = _macro_operator(spec, tools, published)
    return {"text": body, "published": published, "skipped": skipped}


def install_title_template(
    spec: dict[str, Any], dest_dir: Path | str | None = None
) -> dict[str, Any]:
    """Write the spec's title template .setting with a chair_ prefix."""
    rendered = spec_to_macro(spec)
    if "fallback" in rendered:
        return rendered
    target = Path(dest_dir) if dest_dir is not None else title_template_dir()
    target.mkdir(parents=True, exist_ok=True)
    path = target / f"chair_{spec['id']}.setting"
    path.write_text(rendered["text"], encoding="utf-8")
    return {"path": str(path)}


def rig_frames_to_baked(frames: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Map rig sim frames ({time,x,y,rotation,scaleX,scaleY}) to baked keys."""
    baked: dict[str, list[dict[str, Any]]] = {"x": [], "y": [], "rotation": [], "scale": []}
    for frame in frames:
        t = float(frame["time"])
        baked["x"].append({"time": t, "value": float(frame["x"])})
        baked["y"].append({"time": t, "value": float(frame["y"])})
        baked["rotation"].append({"time": t, "value": float(frame.get("rotation", 0))})
        baked["scale"].append({"time": t, "value": float(frame.get("scaleX", 1))})
    return baked


def _fx_list(params: dict[str, Any]) -> list[dict[str, Any]]:
    fx = params.get("fx", [])
    if not isinstance(fx, list):
        return []
    return [entry for entry in fx if isinstance(entry, dict)]


def _num(value: float) -> str:
    if isinstance(value, bool):
        raise TypeError("bool is not a number")
    if float(value).is_integer():
        return str(int(value))
    return f"{float(value):.6g}"


def _str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise ValueError(f"Color {value!r} is not #rgb or #rrggbb.")
    return (
        int(text[0:2], 16) / 255,
        int(text[2:4], 16) / 255,
        int(text[4:6], 16) / 255,
    )


def _frame(time_sec: float, fps: float) -> int:
    return int(round(float(time_sec) * fps))


def _spline_keys(keyframes: list[dict[str, Any]], fps: float) -> list[tuple[int, str]]:
    """Spec keys -> (frame, value text) with LH/RH handles and easing flags."""
    out: list[tuple[int, str]] = []
    for key in sorted(keyframes, key=lambda k: float(k["time"])):
        frame = _frame(key["time"], fps)
        parts = [_num(float(key["value"]))]
        incoming = key.get("inHandle")
        if isinstance(incoming, (list, tuple)) and len(incoming) == 2:
            parts.append(
                f"LH = {{ {_num(float(incoming[0]) * fps)}, {_num(float(incoming[1]))}, }}"
            )
        outgoing = key.get("outHandle")
        if isinstance(outgoing, (list, tuple)) and len(outgoing) == 2:
            parts.append(
                f"RH = {{ {_num(float(outgoing[0]) * fps)}, {_num(float(outgoing[1]))}, }}"
            )
        easing = key.get("easing", "linear")
        if easing == "linear":
            parts.append("Flags = { Linear = true }")
        elif easing == "hold":
            parts.append("Flags = { StepIn = true }")
        out.append((frame, "{ " + ", ".join(parts) + ", }"))
    return out


def _spline_block(name: str, keys: list[tuple[int, str]]) -> str:
    lines = [
        f"\t\t{name} = BezierSpline {{",
        "\t\t\tSplineColor = { Red = 14, Green = 221, Blue = 144, },",
        "\t\t\tNameSet = true,",
        "\t\t\tKeyFrames = {",
    ]
    for frame, text in keys:
        lines.append(f"\t\t\t\t[{frame}] = {text}")
    lines.append("\t\t\t}")
    lines.append("\t\t},")
    return "\n".join(lines)


def _tool_id(prefix: str, layer_id: str) -> str:
    clean = "".join(ch if ch.isalnum() else "_" for ch in layer_id).strip("_") or "layer"
    if clean[0].isdigit():
        clean = f"l{clean}"
    return f"{prefix}_{clean}"


class _Graph:
    """One ordered tool chain per visible layer, merged back to front."""

    # AddTool registry ids for the mask node types used in .comp text.
    MASK_REGISTRY = {"Rectangle": "RectangleMask", "Ellipse": "EllipseMask"}

    def __init__(
        self,
        spec: dict[str, Any],
        baked: dict[str, dict[str, list[dict[str, Any]]]],
        sequences: dict[str, Any] | None = None,
        record: list[dict[str, Any]] | None = None,
    ) -> None:
        self.spec = spec
        self.baked = baked
        self.sequences = sequences or {}
        self.paths: dict[str, str] = {}
        self.fps = float(spec["fps"])
        self.width = float(spec["width"])
        self.height = float(spec["height"])
        self.layers = [layer for layer in spec["layers"] if layer.get("visible", True)]
        self._pos = 0
        self.record = record

    def _place(self, dx: int = 110) -> str:
        self._pos += dx
        return f"{{ {self._pos}, 82.5, }}"

    # -- plan recording (spec_to_plan; None keeps the text path untouched) --

    def _rec(
        self,
        name: str,
        tool: str,
        layer: dict[str, Any] | None,
        role: str,
        existing: bool = False,
    ) -> dict[str, Any] | None:
        """Append one plan tool entry, or None when not recording."""
        if self.record is None:
            return None
        entry: dict[str, Any] = {
            "name": name,
            "tool": tool,
            "layer": layer["id"] if layer is not None else None,
            "role": role,
            "existing": existing,
            "values": {},
            "gradient": {},
            "connect": {},
            "splines": {},
        }
        self.record.append(entry)
        return entry

    def _rec_keys(self, keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Spec/baked keys -> plan keys with frames, handles, easing."""
        out: list[dict[str, Any]] = []
        for key in sorted(keys, key=lambda k: float(k["time"])):
            item: dict[str, Any] = {
                "frame": _frame(key["time"], self.fps),
                "value": float(key["value"]),
                "lh": None,
                "rh": None,
                "easing": key.get("easing", "linear"),
            }
            incoming = key.get("inHandle")
            if isinstance(incoming, (list, tuple)) and len(incoming) == 2:
                item["lh"] = [float(incoming[0]) * self.fps, float(incoming[1])]
            outgoing = key.get("outHandle")
            if isinstance(outgoing, (list, tuple)) and len(outgoing) == 2:
                item["rh"] = [float(outgoing[0]) * self.fps, float(outgoing[1])]
            out.append(item)
        return out

    def _rec_static_spline(
        self,
        entry: dict[str, Any] | None,
        layer: dict[str, Any],
        input_name: str,
        curve_prop: str,
        static: float,
        scale: float = 1,
    ) -> None:
        """Record one input as a static value or an animated spline."""
        if entry is None:
            return
        keys = self.curve(layer, curve_prop)
        if keys is None:
            entry["values"][input_name] = static
            return
        norm = [{**k, "value": float(k["value"]) / scale} for k in keys]
        entry["splines"][input_name] = self._rec_keys(norm)

    # -- coordinates ----------------------------------------------------

    def nx(self, x: float) -> float:
        return float(x) / self.width

    def ny(self, y: float) -> float:
        return 1.0 - float(y) / self.height

    def curve(self, layer: dict[str, Any], prop: str) -> list[dict[str, Any]] | None:
        own = (layer.get("curves") or {}).get(prop)
        keys = None
        if isinstance(own, dict) and isinstance(own.get("keyframes"), list):
            keys = own["keyframes"]
        baked = (self.baked.get(layer["id"]) or {}).get(prop)
        if isinstance(baked, list) and baked:
            keys = baked
        if not keys:
            return None
        return [dict(k) for k in keys if isinstance(k, dict)]

    # -- per-layer chain --------------------------------------------------

    # Shader looks that process footage (not generate it) need a chain to
    # read from; a title template has no footage input for its first layer.
    NEEDS_FOOTAGE = frozenset({"film-grain", "dither", "halftone", "glow"})

    def layer_chain(self, layer: dict[str, Any], background: str | None) -> tuple[list[str], str]:
        """One layer's tools; output is a Merge over background, or the bare
        head when background is None (first layer of a title template)."""
        params = layer.get("params") or {}
        ltype = layer["type"]
        if ltype == "shape":
            blocks, head = self._shape(layer, params)
        elif ltype == "text":
            blocks, head = self._text(layer, params)
        elif ltype == "shader":
            if background is None:
                return self._unwired_shader(layer, params)
            blocks, head = self._shader(layer, params, background)
        else:
            blocks, head = self._image(layer, params)
        head = self._fx_chain(layer, params, blocks, head)
        head = self._transform(layer, params, blocks, head)
        if background is None:
            return blocks, head
        merge = _tool_id("Merge", layer["id"])
        blocks.append(self._merge_block(layer, merge, head, background))
        return blocks, merge

    def _shape(self, layer: dict[str, Any], params: dict[str, Any]) -> tuple[list[str], str]:
        kind = SHAPE_KINDS[params.get("kind", "rect")]
        bg = _tool_id("Bg", layer["id"])
        mask = _tool_id("Mask", layer["id"])
        fill = params.get("fill", "#ffffff")
        r, g, b = _hex_to_rgb(str(fill))
        bg_entry = self._rec(bg, "Background", layer, "source")
        if bg_entry is not None:
            values: dict[str, Any] = {
                "Width": int(self.width),
                "Height": int(self.height),
                "Gamut.SLogVersion": 0,
                "Opacity": float(params.get("opacity", 1)),
            }
            for corner in ("TopLeft", "TopRight", "BottomLeft", "BottomRight"):
                values[f"{corner}Red"] = r
                values[f"{corner}Green"] = g
                values[f"{corner}Blue"] = b
                values[f"{corner}Alpha"] = 1
            bg_entry["values"] = values
            bg_entry["connect"] = {"EffectMask": [mask, "Mask"]}
        corners = []
        for corner in ("TopLeft", "TopRight", "BottomLeft", "BottomRight"):
            corners.append(f"\t\t\t\t\t\t{corner}Red = Input {{ Value = {_num(r)}, }},")
            corners.append(f"\t\t\t\t\t\t{corner}Green = Input {{ Value = {_num(g)}, }},")
            corners.append(f"\t\t\t\t\t\t{corner}Blue = Input {{ Value = {_num(b)}, }},")
            corners.append(f"\t\t\t\t\t\t{corner}Alpha = Input {{ Value = 1, }},")
        opacity = _num(float(params.get("opacity", 1)))
        corners.append(f"\t\t\t\t\t\tOpacity = Input {{ Value = {opacity}, }},")
        bg_block = (
            f"\t\t{bg} = Background {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tWidth = Input {{ Value = {int(self.width)}, }},\n"
            f"\t\t\t\tHeight = Input {{ Value = {int(self.height)}, }},\n"
            f'\t\t\t\t["Gamut.SLogVersion"] = Input {{ Value = 0, }},\n' + "\n".join(corners) + "\n"
            f"\t\t\t\tEffectMask = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{mask}",\n'
            f'\t\t\t\t\tSource = "Mask",\n'
            f"\t\t\t\t}},\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place(-55)}, }},\n"
            f"\t\t}},"
        )
        cx = self.nx(float(params.get("x", self.width / 2)))
        cy = self.ny(float(params.get("y", self.height / 2)))
        mask_inputs = [
            f"\t\t\t\tCenter = Input {{ Value = {{ {_num(cx)}, {_num(cy)}, }}, }},",
        ]
        mask_entry = self._rec(mask, self.MASK_REGISTRY[kind], layer, "mask")
        if mask_entry is not None:
            mask_entry["values"]["Center"] = [cx, cy]
        blocks = [bg_block]
        for prop, input_name, default, scale in (
            ("scaleX", "Width", float(params.get("scaleX", self.width)), self.width),
            ("scaleY", "Height", float(params.get("scaleY", self.height)), self.height),
            ("rotation", "Angle", float(params.get("rotation", 0)), 1),
        ):
            keys = self.curve(layer, prop)
            if keys is None:
                if input_name == "Angle" and default == 0:
                    continue
                mask_inputs.append(
                    f"\t\t\t\t{input_name} = Input {{ Value = {_num(default / scale)}, }},"
                )
                if mask_entry is not None:
                    mask_entry["values"][input_name] = default / scale
            else:
                norm = [
                    {
                        **k,
                        "value": float(k["value"]) / scale,
                    }
                    for k in keys
                ]
                blocks.append(_spline_block(f"{mask}{input_name}", _spline_keys(norm, self.fps)))
                mask_inputs.append(
                    f"\t\t\t\t{input_name} = Input {{\n"
                    f'\t\t\t\t\tSourceOp = "{mask}{input_name}",\n'
                    f'\t\t\t\t\tSource = "Value",\n'
                    f"\t\t\t\t}},"
                )
                if mask_entry is not None:
                    mask_entry["splines"][input_name] = self._rec_keys(norm)
        blocks.append(
            f"\t\t{mask} = {kind} {{\n"
            f"\t\t\tInputs = {{\n" + "\n".join(mask_inputs) + "\n\t\t\t},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return blocks, bg

    def _text(self, layer: dict[str, Any], params: dict[str, Any]) -> tuple[list[str], str]:
        name = _tool_id("Text", layer["id"])
        fill = params.get("fill", "#ffffff")
        r, g, b = _hex_to_rgb(str(fill))
        size_keys = self.curve(layer, "size")
        size_default = float(params.get("size", 96)) / self.height
        styled = _str(str(params.get("string", "")))
        font = _str(self._font(str(params.get("font", "sans-serif"))))
        entry = self._rec(name, "TextPlus", layer, "source")
        if entry is not None:
            entry["values"] = {
                "Width": int(self.width),
                "Height": int(self.height),
                "Gamut.SLogVersion": 0,
                "StyledText": str(params.get("string", "")),
                "Font": self._font(str(params.get("font", "sans-serif"))),
                "Style": "Bold",
                "Red1": r,
                "Green1": g,
                "Blue1": b,
                "Alpha1": 1,
            }
            if size_keys is None:
                entry["values"]["Size"] = size_default
        lines = [
            f"\t\t{name} = TextPlus {{",
            "\t\t\tInputs = {",
            f"\t\t\t\tWidth = Input {{ Value = {int(self.width)}, }},",
            f"\t\t\t\tHeight = Input {{ Value = {int(self.height)}, }},",
            '\t\t\t\t["Gamut.SLogVersion"] = Input { Value = 0, },',
            f"\t\t\t\tStyledText = Input {{ Value = {styled}, }},",
            f"\t\t\t\tFont = Input {{ Value = {font}, }},",
            '\t\t\t\tStyle = Input { Value = "Bold", },',
        ]
        if size_keys is None:
            lines.append(f"\t\t\t\tSize = Input {{ Value = {_num(size_default)}, }},")
        else:
            lines.append(
                f"\t\t\t\tSize = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{name}Size",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},"
            )
        lines += [
            f"\t\t\t\tRed1 = Input {{ Value = {_num(r)}, }},",
            f"\t\t\t\tGreen1 = Input {{ Value = {_num(g)}, }},",
            f"\t\t\t\tBlue1 = Input {{ Value = {_num(b)}, }},",
            "\t\t\t\tAlpha1 = Input { Value = 1, },",
            "\t\t\t},",
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},",
            "\t\t},",
        ]
        blocks = ["\n".join(lines)]
        if size_keys is not None:
            norm = [
                {
                    "time": k["time"],
                    "value": float(k["value"]) / self.height,
                    **{h: k[h] for h in ("easing", "inHandle", "outHandle") if h in k},
                }
                for k in size_keys
            ]
            blocks.append(_spline_block(f"{name}Size", _spline_keys(norm, self.fps)))
            if entry is not None:
                entry["splines"]["Size"] = self._rec_keys(norm)
        return blocks, name

    def _font(self, font: str) -> str:
        return GENERIC_FONTS.get(font.strip().lower(), font)

    def _image(self, layer: dict[str, Any], params: dict[str, Any]) -> tuple[list[str], str]:
        name = _tool_id("Img", layer["id"])
        src = str(params.get("src", ""))
        entry = self._rec(name, "Loader", layer, "source")
        if entry is not None:
            entry["values"] = {"Clip": src}
        block = (
            f"\t\t{name} = Loader {{\n"
            f"\t\t\tClips = {{\n"
            f"\t\t\t\tClip {{\n"
            f'\t\t\t\t\tID = "Clip1",\n'
            f"\t\t\t\t\tFilename = {_str(src)},\n"
            f"\t\t\t\t\tLengthSetManually = true,\n"
            f"\t\t\t\t}}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return [block], name

    def _unwired_shader(
        self, layer: dict[str, Any], params: dict[str, Any]
    ) -> tuple[list[str], str]:
        """A generator shader layer as a title template's first layer.

        Processing looks never reach here: spec_to_macro falls back for
        them because a template has no footage input to process.
        """
        look = params.get("look")
        if look == "fast-noise":
            return self._fast_noise(layer, params)
        if look == "gradient":
            return self._gradient_wash(layer, params)
        raise RuntimeError(
            f"Layer {layer.get('id')!r}: look {look!r} cannot start a title template."
        )

    def _shader(
        self, layer: dict[str, Any], params: dict[str, Any], background: str
    ) -> tuple[list[str], str]:
        """One shader layer's native tools, or its baked-sequence Loader."""
        look = params.get("look")
        files = _sequence_files(self.sequences, str(layer["id"]))
        if look == "film-grain":
            return self._film_grain(layer, params, background)
        if look == "dither":
            return self._dither(layer, params, background)
        if look == "halftone":
            return self._halftone(layer, params, background)
        if look == "fast-noise":
            return self._fast_noise(layer, params)
        if look == "gradient":
            return self._gradient_wash(layer, params)
        if look == "glow":
            return self._look_glow(layer, params, background)
        if files is not None:
            return self._sequence_loader(layer, files)
        raise RuntimeError(
            f"Layer {layer.get('id')!r}: check_spec should have rejected this shader layer."
        )

    def _film_grain(
        self, layer: dict[str, Any], params: dict[str, Any], background: str
    ) -> tuple[list[str], str]:
        """Footage grain: the FilmGrain tool. amount/size stay keyframable."""
        name = _tool_id("Grain", layer["id"])
        blocks: list[str] = []
        amount = self._fx_input(
            blocks, name, "MasterStrength", layer, "amount", float(params.get("amount", 0.5))
        )
        size_keys = self.curve(layer, "size")
        size = float(params.get("size", 1))
        entry = self._rec(name, "FilmGrain", layer, "look")
        if entry is not None:
            entry["connect"] = {"Input": [background, "Output"]}
            entry["values"]["Seed"] = int(params.get("seed", 0))
            entry["values"]["Monochrome"] = 1 if params.get("monochrome", False) else 0
        self._rec_static_spline(entry, layer, "MasterStrength", "amount",
                                float(params.get("amount", 0.5)))
        self._rec_static_spline(entry, layer, "MasterXSize", "size", size)
        self._rec_static_spline(entry, layer, "MasterYSize", "size", size)
        if size_keys is None:
            size_lines = [
                f"\t\t\t\tMasterXSize = Input {{ Value = {_num(size)}, }},",
                f"\t\t\t\tMasterYSize = Input {{ Value = {_num(size)}, }},",
            ]
        else:
            blocks.append(_spline_block(f"{name}MasterXSize", _spline_keys(size_keys, self.fps)))
            blocks.append(_spline_block(f"{name}MasterYSize", _spline_keys(size_keys, self.fps)))
            size_lines = [
                f"\t\t\t\tMasterXSize = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{name}MasterXSize",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},",
                f"\t\t\t\tMasterYSize = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{name}MasterYSize",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},",
            ]
        mono = 1 if params.get("monochrome", False) else 0
        seed = int(params.get("seed", 0))
        blocks.append(
            f"\t\t{name} = FilmGrain {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{background}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{amount}\n" + "\n".join(size_lines) + "\n"
            f"\t\t\t\tSeed = Input {{ Value = {seed}, }},\n"
            f"\t\t\t\tMonochrome = Input {{ Value = {mono}, }},\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        self.paths[str(layer["id"])] = "native:FilmGrain"
        return blocks, name

    def _dither(
        self, layer: dict[str, Any], params: dict[str, Any], background: str
    ) -> tuple[list[str], str]:
        """Ordered Bayer dither: a Custom tool quantizing each channel.

        The 4x4 Bayer matrix is exact integer arithmetic (mod/floor only),
        composed in Python because one channel expression is a single line.
        levels (NumberIn1) stays keyframable; keys must stay >= 2.
        """
        name = _tool_id("Dith", layer["id"])
        blocks: list[str] = []
        levels = self._fx_input(
            blocks, name, "NumberIn1", layer, "levels", float(params.get("levels", 4))
        )
        mx2, my2 = "mod(x,2)", "mod(y,2)"
        b2 = f"({mx2}*(1-{my2})*2+(1-{mx2})*{my2}*3+{mx2}*{my2})"
        qx, qy = "floor(mod(x,4)/2)", "floor(mod(y,4)/2)"
        off = f"({qx}*(1-{qy})*2+(1-{qx})*{qy}*3+{qx}*{qy})"
        threshold = f"((4*{b2}+{off})+0.5)/16"
        entry = self._rec(name, "Custom", layer, "look")
        if entry is not None:
            entry["values"] = {
                "NameforNumber1": "Levels",
                "RedExpression": f"floor(r1*(n1-1)+{threshold})/(n1-1)",
                "GreenExpression": f"floor(g1*(n1-1)+{threshold})/(n1-1)",
                "BlueExpression": f"floor(b1*(n1-1)+{threshold})/(n1-1)",
                "AlphaExpression": "a1",
            }
            entry["connect"] = {"Image1": [background, "Output"]}
        self._rec_static_spline(entry, layer, "NumberIn1", "levels",
                                float(params.get("levels", 4)))
        blocks.append(
            f"\t\t{name} = Custom {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tNumberIn1 = Input {{ Value = 4, }},\n"
            f'\t\t\t\tNameforNumber1 = Input {{ Value = "Levels", }},\n'
            f"\t\t\t\tRedExpression = Input {{ "
            f'Value = "floor(r1*(n1-1)+{threshold})/(n1-1)", }},\n'
            f"\t\t\t\tGreenExpression = Input {{ "
            f'Value = "floor(g1*(n1-1)+{threshold})/(n1-1)", }},\n'
            f"\t\t\t\tBlueExpression = Input {{ "
            f'Value = "floor(b1*(n1-1)+{threshold})/(n1-1)", }},\n'
            f'\t\t\t\tAlphaExpression = Input {{ Value = "a1", }},\n'
            f"\t\t\t\tImage1 = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{background}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{levels}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        self.paths[str(layer["id"])] = "native:Custom(dither)"
        return blocks, name

    def _halftone(
        self, layer: dict[str, Any], params: dict[str, Any], background: str
    ) -> tuple[list[str], str]:
        """Round-dot halftone: a Custom tool screening each channel."""
        name = _tool_id("Halo", layer["id"])
        blocks: list[str] = []
        cell = self._fx_input(
            blocks, name, "NumberIn1", layer, "cell", float(params.get("cell", 12))
        )
        angle = self._fx_input(
            blocks, name, "NumberIn2", layer, "angle", float(params.get("angle", 0.785398))
        )
        # Rotated cell coords and dot distance, inlined per channel so the
        # only unverified mechanism is the `<` comparison itself.
        u = "((x*cos(n2)+y*sin(n2))/n1)"
        v = "((-x*sin(n2)+y*cos(n2))/n1)"
        fu = f"({u}-floor({u}+0.5))"
        fv = f"({v}-floor({v}+0.5))"
        dot = f"({fu}*{fu}+{fv}*{fv})"
        tone = "((r1+g1+b1)/3)"
        entry = self._rec(name, "Custom", layer, "look")
        if entry is not None:
            screen = f"(1-({dot}<({tone}*0.5)))"
            entry["values"] = {
                "NameforNumber1": "Cell",
                "NameforNumber2": "Angle",
                "RedExpression": f"r1*{screen}",
                "GreenExpression": f"g1*{screen}",
                "BlueExpression": f"b1*{screen}",
                "AlphaExpression": "a1",
            }
            entry["connect"] = {"Image1": [background, "Output"]}
        self._rec_static_spline(entry, layer, "NumberIn1", "cell",
                                float(params.get("cell", 12)))
        self._rec_static_spline(entry, layer, "NumberIn2", "angle",
                                float(params.get("angle", 0.785398)))
        blocks.append(
            f"\t\t{name} = Custom {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tNumberIn1 = Input {{ Value = 12, }},\n"
            f"\t\t\t\tNumberIn2 = Input {{ Value = 0.785398, }},\n"
            f'\t\t\t\tNameforNumber1 = Input {{ Value = "Cell", }},\n'
            f'\t\t\t\tNameforNumber2 = Input {{ Value = "Angle", }},\n'
            f"\t\t\t\tRedExpression = Input {{ "
            f'Value = "r1*(1-({dot}<({tone}*0.5)))", }},\n'
            f"\t\t\t\tGreenExpression = Input {{ "
            f'Value = "g1*(1-({dot}<({tone}*0.5)))", }},\n'
            f"\t\t\t\tBlueExpression = Input {{ "
            f'Value = "b1*(1-({dot}<({tone}*0.5)))", }},\n'
            f'\t\t\t\tAlphaExpression = Input {{ Value = "a1", }},\n'
            f"\t\t\t\tImage1 = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{background}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{cell}\n{angle}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        self.paths[str(layer["id"])] = "native:Custom(halftone)"
        return blocks, name

    def _fast_noise(
        self, layer: dict[str, Any], params: dict[str, Any]
    ) -> tuple[list[str], str]:
        """Stylized noise wash: the FastNoise generator, merged over the chain."""
        name = _tool_id("FNoise", layer["id"])
        blocks: list[str] = []
        detail = self._fx_input(
            blocks, name, "Detail", layer, "detail", float(params.get("detail", 5))
        )
        contrast = self._fx_input(
            blocks, name, "Contrast", layer, "contrast", float(params.get("contrast", 1))
        )
        brightness = self._fx_input(
            blocks, name, "Brightness", layer, "brightness",
            float(params.get("brightness", 0.5)),
        )
        scale = float(params.get("scale", 3))
        seethe = float(params.get("seetheRate", 0.5))
        entry = self._rec(name, "FastNoise", layer, "look")
        if entry is not None:
            entry["values"] = {
                "XScale": scale,
                "YScale": scale,
                "SeetheRate": seethe,
                "Color1Red": 1,
                "Color1Green": 1,
                "Color1Blue": 1,
                "Color2Red": 0,
                "Color2Green": 0,
                "Color2Blue": 0,
                "Width": int(self.width),
                "Height": int(self.height),
                "UseFrameFormatSettings": 0,
            }
        self._rec_static_spline(entry, layer, "Detail", "detail",
                                float(params.get("detail", 5)))
        self._rec_static_spline(entry, layer, "Contrast", "contrast",
                                float(params.get("contrast", 1)))
        self._rec_static_spline(entry, layer, "Brightness", "brightness",
                                float(params.get("brightness", 0.5)))
        blocks.append(
            f"\t\t{name} = FastNoise {{\n"
            f"\t\t\tInputs = {{\n"
            f"{detail}\n{contrast}\n{brightness}\n"
            f"\t\t\t\tXScale = Input {{ Value = {_num(scale)}, }},\n"
            f"\t\t\t\tYScale = Input {{ Value = {_num(scale)}, }},\n"
            f"\t\t\t\tSeetheRate = Input {{ Value = {_num(seethe)}, }},\n"
            f"\t\t\t\tColor1Red = Input {{ Value = 1, }},\n"
            f"\t\t\t\tColor1Green = Input {{ Value = 1, }},\n"
            f"\t\t\t\tColor1Blue = Input {{ Value = 1, }},\n"
            f"\t\t\t\tColor2Red = Input {{ Value = 0, }},\n"
            f"\t\t\t\tColor2Green = Input {{ Value = 0, }},\n"
            f"\t\t\t\tColor2Blue = Input {{ Value = 0, }},\n"
            f"\t\t\t\tWidth = Input {{ Value = {int(self.width)}, }},\n"
            f"\t\t\t\tHeight = Input {{ Value = {int(self.height)}, }},\n"
            f"\t\t\t\tUseFrameFormatSettings = Input {{ Value = 0, }},\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        self.paths[str(layer["id"])] = "native:FastNoise"
        return blocks, name

    def _gradient_wash(
        self, layer: dict[str, Any], params: dict[str, Any]
    ) -> tuple[list[str], str]:
        """Gradient wash: a Background in Gradient mode, merged over the chain."""
        name = _tool_id("GWash", layer["id"])
        colors = params.get("colors", ["#1a1d24", "#05070c"])
        top = _hex_to_rgb(str(colors[0]))
        bottom = _hex_to_rgb(str(colors[1]))
        angle = float(params.get("angle", 180)) * 3.14159265 / 180
        dx, dy = math.cos(angle) / 2, math.sin(angle) / 2
        entry = self._rec(name, "Background", layer, "look")
        if entry is not None:
            entry["values"] = {
                "Width": int(self.width),
                "Height": int(self.height),
                "Gamut.SLogVersion": 0,
                "Type": "Gradient",
                "Start": [0.5 - dx, 0.5 - dy],
                "End": [0.5 + dx, 0.5 + dy],
            }
            entry["gradient"] = {
                "Gradient": [[0, *top, 1], [1, *bottom, 1]],
            }
        blocks = [
            f"\t\t{name} = Background {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tWidth = Input {{ Value = {int(self.width)}, }},\n"
            f"\t\t\t\tHeight = Input {{ Value = {int(self.height)}, }},\n"
            f'\t\t\t\t["Gamut.SLogVersion"] = Input {{ Value = 0, }},\n'
            f'\t\t\t\tType = Input {{ Value = FuID {{ "Gradient", }}, }},\n'
            f"\t\t\t\tStart = Input {{ Value = {{ {_num(0.5 - dx)}, {_num(0.5 - dy)}, }}, }},\n"
            f"\t\t\t\tEnd = Input {{ Value = {{ {_num(0.5 + dx)}, {_num(0.5 + dy)}, }}, }},\n"
            f"\t\t\t\tGradient = Input {{\n"
            f"\t\t\t\t\tValue = Gradient {{\n"
            f"\t\t\t\t\t\tColors = {{\n"
            f"\t\t\t\t\t\t\t[0] = {{ {_num(top[0])}, {_num(top[1])}, "
            f"{_num(top[2])}, 1 }},\n"
            f"\t\t\t\t\t\t\t[1] = {{ {_num(bottom[0])}, {_num(bottom[1])}, "
            f"{_num(bottom[2])}, 1 }}\n"
            f"\t\t\t\t\t\t}}\n"
            f"\t\t\t\t\t}},\n"
            f"\t\t\t\t}},\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        ]
        self.paths[str(layer["id"])] = "native:Background(gradient)"
        return blocks, name

    def _look_glow(
        self, layer: dict[str, Any], params: dict[str, Any], background: str
    ) -> tuple[list[str], str]:
        """Glow wash: SoftGlow straight on the chain."""
        name = _tool_id("LGlow", layer["id"])
        blocks: list[str] = []
        gain = self._fx_input(
            blocks, name, "Gain", layer, "gain", float(params.get("gain", 1))
        )
        threshold = self._fx_input(
            blocks, name, "Threshold", layer, "threshold",
            float(params.get("threshold", 0.5)),
        )
        entry = self._rec(name, "SoftGlow", layer, "look")
        if entry is not None:
            entry["connect"] = {"Input": [background, "Output"]}
        self._rec_static_spline(entry, layer, "Gain", "gain",
                                float(params.get("gain", 1)))
        self._rec_static_spline(entry, layer, "Threshold", "threshold",
                                float(params.get("threshold", 0.5)))
        blocks.append(
            f"\t\t{name} = SoftGlow {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{background}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{gain}\n{threshold}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        self.paths[str(layer["id"])] = "native:SoftGlow"
        return blocks, name

    def _sequence_loader(
        self, layer: dict[str, Any], files: list[str]
    ) -> tuple[list[str], str]:
        """Baked web render: a Loader over the PNG sequence, merged over the chain."""
        name = _tool_id("Seq", layer["id"])
        entry = self._rec(name, "Loader", layer, "look")
        if entry is not None:
            entry["values"] = {"Clip": files[0]}
        blocks = [
            f"\t\t{name} = Loader {{\n"
            f"\t\t\tClips = {{\n"
            f"\t\t\t\tClip {{\n"
            f'\t\t\t\t\tID = "Clip1",\n'
            f"\t\t\t\t\tFilename = {_str(files[0])},\n"
            f"\t\t\t\t\tLength = {len(files)},\n"
            f"\t\t\t\t\tLengthSetManually = true,\n"
            f"\t\t\t\t}}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        ]
        self.paths[str(layer["id"])] = "baked:Loader"
        return blocks, name

    def _fx_chain(
        self,
        layer: dict[str, Any],
        params: dict[str, Any],
        blocks: list[str],
        head: str,
    ) -> str:
        for entry in _fx_list(params):
            kind = entry.get("kind")
            if kind == "blur":
                head = self._blur(layer, entry, blocks, head)
            elif kind == "glow":
                head = self._glow(layer, entry, blocks, head)
            elif kind == "grade":
                head = self._grade(layer, entry, blocks, head)
        return head

    def _fx_input(
        self,
        blocks: list[str],
        tool: str,
        input_name: str,
        layer: dict[str, Any],
        curve_prop: str | None,
        static: float,
    ) -> str:
        keys = self.curve(layer, curve_prop) if curve_prop else None
        if keys is None:
            return f"\t\t\t\t{input_name} = Input {{ Value = {_num(static)}, }},"
        blocks.append(_spline_block(f"{tool}{input_name}", _spline_keys(keys, self.fps)))
        return (
            f"\t\t\t\t{input_name} = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{tool}{input_name}",\n'
            f'\t\t\t\t\tSource = "Value",\n'
            f"\t\t\t\t}},"
        )

    def _blur(
        self, layer: dict[str, Any], entry: dict[str, Any], blocks: list[str], head: str
    ) -> str:
        name = _tool_id("Blur", layer["id"])
        size_line = self._fx_input(
            blocks, name, "BlurSize", layer, "blur", float(entry.get("size", 2))
        )
        tool_entry = self._rec(name, "Blur", layer, "fx")
        if tool_entry is not None:
            tool_entry["connect"] = {"Input": [head, "Output"]}
        self._rec_static_spline(tool_entry, layer, "BlurSize", "blur",
                                float(entry.get("size", 2)))
        blocks.append(
            f"\t\t{name} = Blur {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{head}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{size_line}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return name

    def _glow(
        self, layer: dict[str, Any], entry: dict[str, Any], blocks: list[str], head: str
    ) -> str:
        name = _tool_id("Glow", layer["id"])
        gain_line = self._fx_input(blocks, name, "Gain", layer, "glow", float(entry.get("gain", 1)))
        tool_entry = self._rec(name, "SoftGlow", layer, "fx")
        if tool_entry is not None:
            tool_entry["connect"] = {"Input": [head, "Output"]}
        self._rec_static_spline(tool_entry, layer, "Gain", "glow",
                                float(entry.get("gain", 1)))
        blocks.append(
            f"\t\t{name} = SoftGlow {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{head}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{gain_line}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return name

    def _grade(
        self, layer: dict[str, Any], entry: dict[str, Any], blocks: list[str], head: str
    ) -> str:
        name = _tool_id("Grade", layer["id"])
        gain_line = self._fx_input(blocks, name, "Gain", layer, None, float(entry.get("gain", 1)))
        tool_entry = self._rec(name, "ColorCorrector", layer, "fx")
        if tool_entry is not None:
            tool_entry["connect"] = {"Input": [head, "Output"]}
            tool_entry["values"] = {"Gain": float(entry.get("gain", 1))}
        blocks.append(
            f"\t\t{name} = ColorCorrector {{\n"
            f"\t\t\tInputs = {{\n"
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{head}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},\n"
            f"{gain_line}\n"
            f"\t\t\t}},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return name

    def _transform(
        self,
        layer: dict[str, Any],
        params: dict[str, Any],
        blocks: list[str],
        head: str,
    ) -> str:
        name = _tool_id("Xf", layer["id"])
        x_keys = self.curve(layer, "x")
        y_keys = self.curve(layer, "y")
        inputs: list[str] = []
        entry: dict[str, Any] | None = None
        if x_keys is not None or y_keys is not None:
            xy = f"{name}XY"
            x_static = float(params.get("x", self.width / 2))
            y_static = float(params.get("y", self.height / 2))
            x_list = x_keys or [{"time": 0, "value": x_static}]
            y_list = y_keys or [{"time": 0, "value": y_static}]
            x_norm = [{**k, "value": self.nx(float(k["value"]))} for k in x_list]
            y_norm = [{**k, "value": self.ny(float(k["value"]))} for k in y_list]
            xp_entry = self._rec(xy, "XYPath", layer, "xpath")
            if xp_entry is not None:
                xp_entry["splines"] = {
                    "X": self._rec_keys(x_norm),
                    "Y": self._rec_keys(y_norm),
                }
            entry = self._rec(name, "Transform", layer, "transform")
            if entry is not None:
                entry["connect"]["Center"] = [xy, "Value"]
            blocks.append(
                "\n".join(
                    [
                        f"\t\t{xy} = XYPath {{",
                        "\t\t\tInputs = {",
                        "\t\t\t\tX = Input {",
                        f'\t\t\t\t\tSourceOp = "{xy}X",',
                        '\t\t\t\t\tSource = "Value",',
                        "\t\t\t\t},",
                        "\t\t\t\tY = Input {",
                        f'\t\t\t\t\tSourceOp = "{xy}Y",',
                        '\t\t\t\t\tSource = "Value",',
                        "\t\t\t\t},",
                        "\t\t\t},",
                        "\t\t},",
                    ]
                )
            )
            blocks.append(_spline_block(f"{xy}X", _spline_keys(x_norm, self.fps)))
            blocks.append(_spline_block(f"{xy}Y", _spline_keys(y_norm, self.fps)))
            inputs.append(
                f"\t\t\t\tCenter = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{xy}",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},"
            )
        else:
            cx = self.nx(float(params.get("x", self.width / 2)))
            cy = self.ny(float(params.get("y", self.height / 2)))
            inputs.append(f"\t\t\t\tCenter = Input {{ Value = {{ {_num(cx)}, {_num(cy)}, }}, }},")
            entry = self._rec(name, "Transform", layer, "transform")
            if entry is not None:
                entry["values"]["Center"] = [cx, cy]
        assert entry is not None or self.record is None
        # Shape layers carry rotation and scaleX/scaleY on the mask node
        # itself (scalar splines, which survive import); Transform skips them.
        is_shape = layer["type"] == "shape"
        rot_keys = None if is_shape else self.curve(layer, "rotation")
        if rot_keys is not None:
            blocks.append(_spline_block(f"{name}Angle", _spline_keys(rot_keys, self.fps)))
            inputs.append(
                f"\t\t\t\tAngle = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{name}Angle",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},"
            )
            if entry is not None:
                entry["splines"]["Angle"] = self._rec_keys(rot_keys)
        elif not is_shape and float(params.get("rotation", 0)) != 0:
            inputs.append(
                f"\t\t\t\tAngle = Input {{ Value = {_num(float(params['rotation']))}, }},"
            )
            if entry is not None:
                entry["values"]["Angle"] = float(params["rotation"])
        if is_shape:
            scale_keys = self.curve(layer, "scale")
            size_default = float(params.get("scale", 1))
        else:
            scale_keys = self.curve(layer, "scale") or self.curve(layer, "scaleX")
            size_default = float(params.get("scale", params.get("scaleX", 1)))
        if scale_keys is not None:
            blocks.append(_spline_block(f"{name}Size", _spline_keys(scale_keys, self.fps)))
            inputs.append(
                f"\t\t\t\tSize = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{name}Size",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},"
            )
            if entry is not None:
                entry["splines"]["Size"] = self._rec_keys(scale_keys)
        elif size_default != 1:
            inputs.append(f"\t\t\t\tSize = Input {{ Value = {_num(size_default)}, }},")
            if entry is not None:
                entry["values"]["Size"] = size_default
        if entry is not None:
            entry["connect"]["Input"] = [head, "Output"]
        inputs.append(
            f"\t\t\t\tInput = Input {{\n"
            f'\t\t\t\t\tSourceOp = "{head}",\n'
            f'\t\t\t\t\tSource = "Output",\n'
            f"\t\t\t\t}},"
        )
        blocks.append(
            f"\t\t{name} = Transform {{\n"
            f"\t\t\tInputs = {{\n" + "\n".join(inputs) + "\n\t\t\t},\n"
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},\n"
            f"\t\t}},"
        )
        return name

    def _merge_block(self, layer: dict[str, Any], merge: str, head: str, background: str) -> str:
        """A Merge compositing head over background."""
        params = layer.get("params") or {}
        blend = BLEND_MODES.get(str(layer.get("blend", "normal")), "Normal")
        entry = self._rec(merge, "Merge", layer, "merge")
        if entry is not None:
            entry["connect"] = {
                "Background": [background, "Output"],
                "Foreground": [head, "Output"],
            }
            if blend != "Normal":
                entry["values"]["ApplyMode"] = blend
            else:
                entry["values"]["PerformDepthMerge"] = 0
        self._rec_static_spline(entry, layer, "Blend", "opacity",
                                float(params.get("opacity", 1)))
        opacity_keys = self.curve(layer, "opacity")
        if opacity_keys is None:
            blend_line = (
                f"\t\t\t\tBlend = Input {{ Value = {_num(float(params.get('opacity', 1)))}, }},"
            )
        else:
            blend_line = (
                f"\t\t\t\tBlend = Input {{\n"
                f'\t\t\t\t\tSourceOp = "{merge}Blend",\n'
                f'\t\t\t\t\tSource = "Value",\n'
                f"\t\t\t\t}},"
            )
        bg_line = (
            "\t\t\t\tBackground = Input {\n"
            f'\t\t\t\t\tSourceOp = "{background}",\n'
            '\t\t\t\t\tSource = "Output",\n'
            "\t\t\t\t},"
        )
        mode_line = (
            f"\t\t\t\tApplyMode = Input {{ Value = FuID {{ {_str(blend)}, }}, }},"
            if blend != "Normal"
            else "\t\t\t\tPerformDepthMerge = Input { Value = 0, },"
        )
        lines = [
            f"\t\t{merge} = Merge {{",
            "\t\t\tInputs = {",
            bg_line,
            "\t\t\t\tForeground = Input {",
            f'\t\t\t\t\tSourceOp = "{head}",',
            '\t\t\t\t\tSource = "Output",',
            "\t\t\t\t},",
            mode_line,
            blend_line,
            "\t\t\t},",
            f"\t\t\tViewInfo = OperatorInfo {{ Pos = {self._place()}, }},",
            "\t\t},",
        ]
        if opacity_keys is not None:
            lines.append(_spline_block(f"{merge}Blend", _spline_keys(opacity_keys, self.fps)))
        return "\n".join(lines)

    # -- assembly --------------------------------------------------------

    def comp_tools(self, media: dict[str, Any] | None) -> tuple[list[str], str]:
        blocks = [self._media_in(media)]
        previous = "MediaIn1"
        for layer in self.layers:
            chain, previous = self.layer_chain(layer, previous)
            blocks.extend(chain)
        blocks.append(self._media_out(previous))
        return blocks, previous

    def macro_tools(self) -> tuple[list[str], str]:
        blocks: list[str] = []
        previous: str | None = None
        for layer in self.layers:
            chain, previous = self.layer_chain(layer, previous)
            blocks.extend(chain)
        assert previous is not None  # check_spec guarantees a layer
        return blocks, previous

    def _media_in(self, media: dict[str, Any] | None) -> str:
        total = max(1, int(round(float(self.spec["durationSec"]) * self.fps)))
        self._rec("MediaIn1", "Loader", None, "spine", existing=True)
        lines = [
            "\t\tMediaIn1 = Loader {",
            "\t\t\tExtentSet = true,",
            "\t\t\tInputs = {",
            f"\t\t\t\tGlobalOut = Input {{ Value = {total}, }},",
            '\t\t\t\tLayer = Input { Value = "0", },',
            f"\t\t\t\tClipTimeEnd = Input {{ Value = {total}, }},",
            "\t\t\t},",
        ]
        if media and media.get("path"):
            lines += [
                "\t\t\tClips = {",
                "\t\t\t\tClip {",
                '\t\t\t\t\tID = "Clip1",',
                "\t\t\t\t\tMultiframe = true,",
                f"\t\t\t\t\tFilename = {_str(str(media['path']))},",
                f"\t\t\t\t\tLength = {int(media.get('frames', total))},",
                "\t\t\t\t\tLengthSetManually = true,",
                "\t\t\t\t}",
                "\t\t\t},",
            ]
        lines += [
            "\t\t\tViewInfo = OperatorInfo { Pos = { -275, 82.5, }, },",
            "\t\t},",
        ]
        return "\n".join(lines)

    def _media_out(self, source: str) -> str:
        entry = self._rec("MediaOut1", "Saver", None, "spine", existing=True)
        if entry is not None:
            entry["connect"] = {"Input": [source, "Output"]}
        return "\n".join(
            [
                "\t\tMediaOut1 = Saver {",
                "\t\t\tInputs = {",
                '\t\t\t\tIndex = Input { Value = "0", },',
                "\t\t\t\tInput = Input {",
                f'\t\t\t\t\tSourceOp = "{source}",',
                '\t\t\t\t\tSource = "Output",',
                "\t\t\t\t}",
                "\t\t\t},",
                "\t\t},",
            ]
        )


def _composition(spec: dict[str, Any], tools: tuple[list[str], str]) -> str:
    blocks, _ = tools
    fps = float(spec["fps"])
    total = max(1, int(round(float(spec["durationSec"]) * fps)))
    width = int(spec["width"])
    height = int(spec["height"])
    body = "\n".join(blocks)
    return f"""Composition {{
\tCurrentTime = 0,
\tRenderRange = {{ 0, {total - 1} }},
\tGlobalRange = {{ 0, {total} }},
\tCurrentID = 3,
\tHiQ = true,
\tPlaybackUpdateMode = 0,
\tStereoMode = false,
\tVersion = {_str(FUSION_VERSION)},
\tSavedOutputs = 0,
\tHeldTools = 0,
\tDisabledTools = 0,
\tLockedTools = 0,
\tAudioOffset = 0,
\tResumable = true,
\tOutputClips = {{
\t}},
\tTools = {{
{body}
\t}},
\tFrames = {{
\t}},
\tPrefs = {{
\t\tComp = {{
\t\t\tInteractive = {{
\t\t\t\tProxy = {{
\t\t\t\t\tScale = 1,
\t\t\t\t}},
\t\t\t}},
\t\t\tFrameFormat = {{
\t\t\t\tGuideRatio = {_num(width / height)},
\t\t\t\tDepthPreview = 3,
\t\t\t\tRate = {_num(fps)},
\t\t\t\tDepthFull = 3,
\t\t\t\tDepthInteractive = 3,
\t\t\t}},
\t\t\tUnsorted = {{
\t\t\t\tGlobalEnd = {total}
\t\t\t}},
\t\t\tViews = {{
\t\t\t\tView1 = {{
\t\t\t\t}},
\t\t\t}},
\t\t\tSpellCheck = {{
\t\t\t}}
\t\t}},
\t}},
}}"""


def _macro_operator(
    spec: dict[str, Any], tools: tuple[list[str], str], published: list[dict[str, Any]]
) -> str:
    blocks, output = tools
    macro = _tool_id("chair", str(spec["id"]))
    body = "\n".join(blocks)
    inputs = []
    for index, control in enumerate(published, start=1):
        lines = [
            f"\t\t\t\tInput{index} = InstanceInput {{",
            f'\t\t\t\t\tSourceOp = "{control["tool"]}",',
            f'\t\t\t\t\tSource = "{control["source"]}",',
            f"\t\t\t\t\tName = {_str(control['label'])},",
        ]
        if control.get("group") is not None:
            lines.append(f"\t\t\t\t\tControlGroup = {control['group']},")
        if control.get("default") is not None:
            default = control["default"]
            rendered = _str(default) if isinstance(default, str) else _num(float(default))
            lines.append(f"\t\t\t\t\tDefault = {rendered},")
        lines.append("\t\t\t\t},")
        inputs.append("\n".join(lines))
    inputs_text = "\n".join(inputs)
    head = [
        "{",
        "\tTools = ordered() {",
        f"\t\t{macro} = MacroOperator {{",
        "\t\t\tCtrlWZoom = false,",
        "\t\t\tNameSet = true,",
        "\t\t\tInputs = ordered() {",
        inputs_text,
        "\t\t\t},",
        "\t\t\tOutputs = {",
        "\t\t\t\tMainOutput1 = InstanceOutput {",
        f'\t\t\t\t\tSourceOp = "{output}",',
        '\t\t\t\t\tSource = "Output",',
        "\t\t\t\t}",
        "\t\t\t},",
        "\t\t\tViewInfo = GroupInfo {",
        "\t\t\t\tPos = { 0, 0 },",
        "\t\t\t\tFlags = {",
        "\t\t\t\t\tExpanded = { true },",
        "\t\t\t\t\tAllowPan = { true },",
        "\t\t\t\t\tAutoSnap = { true },",
        "\t\t\t\t\tRemoveRouters = { true }",
        "\t\t\t\t},",
        "\t\t\t\tSize = { 516, 186, 112.5, 22 },",
        '\t\t\t\tDirection = "Horizontal",',
        '\t\t\t\tPipeStyle = "Direct",',
        "\t\t\t\tScale = 1,",
        "\t\t\t\tOffset = { 0, 0 }",
        "\t\t\t},",
        "\t\t\tTools = ordered() {",
        body,
        "\t\t\t},",
        "\t\t}",
        "\t},",
        f'\tActiveTool = "{macro}"',
        "}",
    ]
    return "\n".join(head)


def _published_controls(
    spec: dict[str, Any], graph: _Graph
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Map spec controls to InstanceInputs. Returns (published, skipped)."""
    by_layer = {layer["id"]: layer for layer in spec["layers"]}
    published: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    group = 0
    for control in spec.get("controls") or []:
        cid = str(control.get("id", "?"))
        target = control.get("target") or {}
        layer = by_layer.get(target.get("layerId"))
        if layer is None:
            skipped.append({"id": cid, "reason": f"unknown layer {target.get('layerId')!r}"})
            continue
        param = target.get("param")
        entries = _control_inputs(graph, layer, param, control)
        if entries is None:
            skipped.append(
                {"id": cid, "reason": f"param {param!r} on {layer['id']!r} is not published"}
            )
            continue
        if len(entries) > 1:
            group += 1
        for tool, source, default in entries:
            published.append(
                {
                    "id": cid,
                    "label": str(control.get("label", cid)),
                    "tool": tool,
                    "source": source,
                    "default": default,
                    "group": group if len(entries) > 1 else None,
                }
            )
    return published, skipped


def _control_inputs(
    graph: _Graph, layer: dict[str, Any], param: str, control: dict[str, Any]
) -> list[tuple[str, str, Any]] | None:
    """(tool, Source, default) InstanceInputs for one control, else None."""
    ltype = layer["type"]
    params = layer.get("params") or {}
    ctype = control.get("type")
    if ltype == "text" and param == "string" and ctype == "text":
        return [(_tool_id("Text", layer["id"]), "StyledText", params.get("string", ""))]
    if ltype == "text" and param == "font":
        return [(_tool_id("Text", layer["id"]), "Font", params.get("font", "sans-serif"))]
    if ltype == "text" and param == "size" and ctype == "number":
        default = float(params.get("size", 96)) / graph.height
        return [(_tool_id("Text", layer["id"]), "Size", default)]
    if param == "fill" and ctype == "color":
        fill = params.get("fill", "#ffffff")
        try:
            r, g, b = _hex_to_rgb(str(control.get("default", fill)))
        except ValueError:
            r, g, b = _hex_to_rgb(str(fill))
        if ltype == "text":
            name = _tool_id("Text", layer["id"])
            return [(name, "Red1", r), (name, "Green1", g), (name, "Blue1", b)]
        if ltype == "shape":
            name = _tool_id("Bg", layer["id"])
            return [(name, "TopLeftRed", r), (name, "TopLeftGreen", g), (name, "TopLeftBlue", b)]
        return None
    if param == "rotation" and ctype == "number":
        if ltype == "shape":
            return None  # mask Angle is not a published control
        return [(_tool_id("Xf", layer["id"]), "Angle", float(params.get("rotation", 0)))]
    if param == "opacity" and ctype == "number":
        return [(_tool_id("Merge", layer["id"]), "Blend", float(params.get("opacity", 1)))]
    if param == "blur" and ctype == "number":
        for entry in _fx_list(params):
            if entry.get("kind") == "blur":
                return [(_tool_id("Blur", layer["id"]), "BlurSize", float(entry.get("size", 2)))]
        return None
    if param == "glow" and ctype == "number":
        for entry in _fx_list(params):
            if entry.get("kind") == "glow":
                return [(_tool_id("Glow", layer["id"]), "Gain", float(entry.get("gain", 1)))]
        return None
    look = params.get("look")
    if look == "film-grain" and ctype == "number":
        if param == "amount":
            return [(_tool_id("Grain", layer["id"]), "MasterStrength",
                     float(params.get("amount", 0.5)))]
        if param == "size":
            default = float(params.get("size", 1))
            return [(_tool_id("Grain", layer["id"]), "MasterXSize", default),
                    (_tool_id("Grain", layer["id"]), "MasterYSize", default)]
    if look == "dither" and param == "levels" and ctype == "number":
        return [(_tool_id("Dith", layer["id"]), "NumberIn1",
                 float(params.get("levels", 4)))]
    if look == "halftone" and ctype == "number":
        if param == "cell":
            return [(_tool_id("Halo", layer["id"]), "NumberIn1",
                     float(params.get("cell", 12)))]
        if param == "angle":
            return [(_tool_id("Halo", layer["id"]), "NumberIn2",
                     float(params.get("angle", 0.785398)))]
    if look == "fast-noise" and ctype == "number":
        if param in ("detail", "contrast", "brightness"):
            tool = _tool_id("FNoise", layer["id"])
            source = {"detail": "Detail", "contrast": "Contrast",
                      "brightness": "Brightness"}[param]
            default = {"detail": 5, "contrast": 1, "brightness": 0.5}[param]
            return [(tool, source, float(params.get(param, default)))]
    if look == "glow" and ctype == "number":
        if param == "gain":
            return [(_tool_id("LGlow", layer["id"]), "Gain",
                     float(params.get("gain", 1)))]
        if param == "threshold":
            return [(_tool_id("LGlow", layer["id"]), "Threshold",
                     float(params.get("threshold", 0.5)))]
    return None
