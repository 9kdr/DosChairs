from pydantic import BaseModel, ConfigDict


class ToolSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    summary: str
    destructive: bool = False


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(name="sam3_mask", summary="Tracked mattes from a text, point, or box prompt"),
    ToolSpec(name="sam_audio", summary="Stems on new audio tracks; originals stay muted"),
    ToolSpec(name="transcribe", summary="Word-timed transcript and a subtitle track"),
    ToolSpec(name="editor_op", summary="Cut, trim, ripple, move, speed, markers"),
    ToolSpec(name="render_preview", summary="Low-res frames and audio for the verifier"),
    ToolSpec(name="get_frame", summary="Single frame at time t"),
    ToolSpec(name="measure_audio", summary="Loudness and speech, music, noise spans"),
)
