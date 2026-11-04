from pydantic import BaseModel, ConfigDict


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyframes: bool
    fusion_comps: bool
    fusion_macros: bool = True
    fusion_build_api: bool = True
    template_scan: bool = True
    ograf_titles: bool = True
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
    audio_capabilities: dict[str, bool] = {
        "place_sfx_on_new_track": True,
        "volume_keyframes": False,
    }


MANIFEST = Manifest(
    adapter="resolve",
    version="0.1.0",
    capabilities=Capabilities(
        keyframes=True,
        fusion_comps=True,
        fusion_macros=True,
        ograf_titles=True,
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
        "fusionMacros": (
            "tag the shader layer with a native look (params.look: film-grain, "
            "dither, halftone, fast-noise, gradient, glow) or bake its web "
            "render to a PNG sequence for the Loader path; otherwise render "
            "the effect to a clip and place it by hand"
        ),
        "fusionBuild": (
            "comps are built tool-by-tool through the scripting API on a "
            "new comp version; ImportFusionComp is an opt-in fast path only, "
            "used when it actually ingests nodes"
        ),
        "templateScan": "no Fusion folder found: name the macro in the brief by hand",
        "ografTitles": "install with install_ograf, then drag from Effects > Titles > OGraf",
        "placeSfx": (
            "import the SFX file into the media pool, "
            "then append it to a new audio track by hand"
        ),
        "audioKeyframes": (
            "Studio scripting cannot set Fairlight volume keyframes: "
            "select the music clip in Fairlight, open the Automation lane, "
            "and add the -12 dB ducking ramps from the changeset patch by hand"
        ),
    },
)
