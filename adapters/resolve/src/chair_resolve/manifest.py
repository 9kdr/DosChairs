from pydantic import BaseModel, ConfigDict


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyframes: bool
    fusion_comps: bool
    fusion_macros: bool = True
    template_scan: bool = True
    adjustment_layers: bool
    markers: bool
    subtitles: bool
    nested_sequences: bool
    speed_changes: bool


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    adapter: str
    version: str
    capabilities: Capabilities
    fallbacks: dict[str, str]


MANIFEST = Manifest(
    adapter="resolve",
    version="0.1.0",
    capabilities=Capabilities(
        keyframes=True,
        fusion_comps=True,
        adjustment_layers=True,
        markers=True,
        subtitles=True,
        nested_sequences=True,
        speed_changes=True,
    ),
    # Write direction only: Studio scripting cannot place these tracks or
    # retime clips, so the planner skips or flags them. Reading supports them,
    # so the flags above stay True.
    fallbacks={
        "subtitles": "import captions in Studio by hand",
        "adjustmentLayers": "add an adjustment clip in Studio by hand",
        "speedChanges": "retime the clip in Studio by hand",
        "fusionMacros": "render the effect to a clip and place it by hand",
        "templateScan": "no Fusion folder found: name the macro in the brief by hand",
    },
)
