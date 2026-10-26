from pydantic import BaseModel, ConfigDict


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyframes: bool
    fusion_comps: bool
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
    adapter="otio",
    version="0.1.0",
    capabilities=Capabilities(
        keyframes=False,
        fusion_comps=False,
        adjustment_layers=False,
        markers=True,
        subtitles=True,
        nested_sequences=True,
        speed_changes=True,
    ),
    fallbacks={
        "keyframes": "baked clip",
        "fusionComps": "prerendered overlay track",
    },
)
