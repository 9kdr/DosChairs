from pydantic import BaseModel, ConfigDict


class ToolSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    summary: str
    destructive: bool = False


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(name="sam3_mask", summary="Tracked mattes from a text, point, or box prompt"),
    ToolSpec(name="sam3d_asset", summary="Masked object to a 3D asset plus placement"),
    ToolSpec(name="sam_audio", summary="Stems on new audio tracks; originals stay muted"),
    ToolSpec(name="muse_image", summary="Generate an image asset with prompt provenance"),
    ToolSpec(name="transcribe", summary="Word-timed transcript and a subtitle track"),
    ToolSpec(name="svg_gen", summary="Editable SVG vector layer"),
    ToolSpec(name="motion_graphics", summary="Parameterized Fusion/MLT template"),
    ToolSpec(name="grade", summary="LUT or node grade from a reference"),
    ToolSpec(name="editor_op", summary="Cut, trim, ripple, move, speed, markers"),
    ToolSpec(name="render_preview", summary="Low-res frames and audio for the verifier"),
    ToolSpec(name="get_frame", summary="Single frame at time t"),
    ToolSpec(name="measure_audio", summary="Loudness and speech, music, noise spans"),
)

# Piece workflows run through one endpoint per effect. Kept beside TOOLS so the
# planner only sees the tools its chosen effect can call.
EFFECT_TOOLS: dict[str, tuple[str, ...]] = {
    "muse_image": ("muse_image",),
    "sam3_mask": ("sam3_mask",),
    "grade": ("grade",),
    "motion_graphics": ("motion_graphics",),
}


def tools_for_effect(effect: str) -> tuple[ToolSpec, ...]:
    """Tools the planner may call for one effect. Rejects unknown effects."""
    try:
        names = EFFECT_TOOLS[effect]
    except KeyError:
        raise ValueError(f"unknown effect: {effect!r}") from None
    return tuple(tool for tool in TOOLS if tool.name in names)
