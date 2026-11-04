from pydantic import BaseModel, ConfigDict


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyframes: bool
    fusion_comps: bool
    open_project: bool = True
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
    adapter="kdenlive",
    version="0.1.0",
    capabilities=Capabilities(
        keyframes=True,
        fusion_comps=False,
        adjustment_layers=False,
        markers=True,
        subtitles=True,
        nested_sequences=True,
        speed_changes=True,
    ),
    fallbacks={
        "fusionComps": "prerendered overlay track",
        "openProject": (
            "open the .kdenlive file in Kdenlive by hand, "
            "then open it again in Chair"
        ),
    },
)
