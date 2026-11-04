import json
import re
import runpy
from pathlib import Path

from chair_resolve.fusion import (
    FALLBACK_CAPABILITY,
    check_spec,
    install_title_template,
    rig_frames_to_baked,
    spec_to_comp,
    spec_to_macro,
)
from chair_resolve.manifest import MANIFEST
from chair_resolve.write import add_effect, load_effect_spec, remove_effect

_FAKES = runpy.run_path(str(Path(__file__).with_name("fake_fusion.py")))
FakeItem = _FAKES["FakeItem"]

FIXTURE = Path(__file__).parents[3] / "fixtures" / "effects" / "bounce-title.effect.json"


def _spec() -> dict:
    return json.loads(FIXTURE.read_text())


def _key_frames(text: str, tool: str) -> list[tuple[int, str]]:
    block = re.search(rf"{re.escape(tool)} = BezierSpline \{{(.*?)\n\t\t\}}", text, re.S)
    assert block is not None, f"missing spline {tool}"
    out = []
    for line in block.group(1).splitlines():
        match = re.match(r"\s*\[(\d+)\] = \{ (.*) \},?\s*$", line)
        if match:
            out.append((int(match.group(1)), match.group(2)))
    assert out, f"no keys parsed for {tool}"
    return out


def test_fixture_serializes_to_balanced_comp() -> None:
    text = spec_to_comp(_spec())["text"]
    assert text.count("{") == text.count("}")
    assert "Composition {" in text
    for tool in (
        "MediaIn1",
        "MediaOut1",
        "Bg_bg",
        "Mask_bg",
        "Text_title",
        "Xf_ball",
        "Merge_bg",
        "Merge_ball",
        "Merge_title",
    ):
        assert tool in text, f"missing tool {tool}"
    assert "Rectangle" in text and "Ellipse" in text and "TextPlus" in text


def test_fixture_keyframes_land_on_frame_numbers() -> None:
    text = spec_to_comp(_spec())["text"]
    y_frames = [frame for frame, _ in _key_frames(text, "Xf_ballXYY")]
    assert y_frames == [0, 15, 30, 42, 54, 63, 72, 81]
    assert [frame for frame, _ in _key_frames(text, "Xf_ballXYX")] == [0, 81]
    assert [frame for frame, _ in _key_frames(text, "Merge_titleBlend")] == [0, 18]
    assert "Transform1Center" not in text  # no direct point spline


def test_animated_position_uses_xpath_not_point_spline() -> None:
    text = spec_to_comp(_spec())["text"]
    assert "Xf_ballXY = XYPath" in text
    assert 'SourceOp = "Xf_ballXY"' in text
    assert 'SourceOp = "Xf_ballXYX"' in text
    assert 'SourceOp = "Xf_ballXYY"' in text


def test_scalar_handles_become_lh_rh() -> None:
    spec = _spec()
    layer = next(layer for layer in spec["layers"] if layer["id"] == "title")
    layer["curves"]["opacity"]["keyframes"][1]["outHandle"] = [0.1, 0.2]
    layer["curves"]["opacity"]["keyframes"][1]["inHandle"] = [-0.1, -0.2]
    text = spec_to_comp(spec)["text"]
    keys = dict(_key_frames(text, "Merge_titleBlend"))
    assert "LH = { -3, -0.2, }" in keys[18]
    assert "RH = { 3, 0.2, }" in keys[18]


def test_shader_layer_falls_back_instead_of_faking() -> None:
    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader", "params": {"entry": "main"}})
    assert check_spec(spec) != []
    result = spec_to_comp(spec)
    assert result["fallback"]["capability"] == FALLBACK_CAPABILITY == "fusionMacro"
    assert "shader" in result["fallback"]["reason"]
    assert spec_to_macro(spec)["fallback"]["capability"] == "fusionMacro"


def test_unknown_layer_and_fx_fall_back() -> None:
    spec = _spec()
    spec["layers"].append({"id": "mystery", "type": "fuse"})
    assert spec_to_comp(spec)["fallback"]["capability"] == "fusionMacro"
    spec2 = _spec()
    spec2["layers"][0]["params"]["fx"] = [{"kind": "lensflare"}]
    assert "lensflare" in spec_to_comp(spec2)["fallback"]["reason"]


def test_fx_chain_maps_blur_glow_grade() -> None:
    spec = _spec()
    spec["layers"][1]["params"]["fx"] = [
        {"kind": "blur", "size": 3},
        {"kind": "glow", "gain": 2},
        {"kind": "grade", "gain": 1.1},
    ]
    text = spec_to_comp(spec)["text"]
    assert text.count("{") == text.count("}")
    assert "Blur_ball = Blur" in text
    assert "Glow_ball = SoftGlow" in text
    assert "Grade_ball = ColorCorrector" in text
    assert "BlurSize = Input { Value = 3" in text
    assert 'SourceOp = "Bg_ball"' in text  # chain still starts at the shape


def test_image_layer_becomes_loader_and_blend_applies() -> None:
    spec = _spec()
    spec["layers"].append(
        {
            "id": "logo",
            "type": "image",
            "params": {"src": "/media/logo.png", "x": 100, "y": 100},
            "blend": "screen",
        }
    )
    text = spec_to_comp(spec)["text"]
    assert "Img_logo = Loader" in text
    assert 'Filename = "/media/logo.png"' in text
    assert 'FuID { "Screen", }' in text


def test_baked_rig_output_overrides_curves() -> None:
    spec = _spec()
    frames = [
        {"time": 0.0, "x": 10, "y": 20, "rotation": 0, "scaleX": 1, "scaleY": 1},
        {"time": 0.5, "x": 30, "y": 40, "rotation": 5, "scaleX": 1.2, "scaleY": 1.2},
    ]
    baked = {"ball": rig_frames_to_baked(frames)}
    text = spec_to_comp(spec, baked=baked)["text"]
    assert [frame for frame, _ in _key_frames(text, "Xf_ballXYX")] == [0, 15]
    assert [frame for frame, _ in _key_frames(text, "Xf_ballXYY")] == [0, 15]


def test_rig_bake_keeps_scaley() -> None:
    """Sweep #8: the squash survives the bounce."""
    baked = rig_frames_to_baked([
        {"time": 0.0, "x": 0, "y": 0, "scaleX": 1.0, "scaleY": 1.0},
        {"time": 0.5, "x": 0, "y": 0, "scaleX": 1.1, "scaleY": 0.9},
    ])
    assert [k["value"] for k in baked["scale"]] == [1.0, 1.1]
    assert [k["value"] for k in baked["scaley"]] == [1.0, 0.9]


def test_baked_scaley_splits_transform_size() -> None:
    spec = _spec()
    frames = [
        {"time": 0.0, "x": 10, "y": 20, "rotation": 0, "scaleX": 1, "scaleY": 1},
        {"time": 0.5, "x": 30, "y": 40, "rotation": 5, "scaleX": 1.2, "scaleY": 0.8},
    ]
    baked = {"ball": rig_frames_to_baked(frames)}
    text = spec_to_comp(spec, baked=baked)["text"]
    assert "UseSizeAndAspect = Input { Value = 0, }" in text
    assert [frame for frame, _ in _key_frames(text, "Xf_ballXSize")] == [0, 15]
    assert [frame for frame, _ in _key_frames(text, "Xf_ballYSize")] == [0, 15]
    assert "Xf_ballSize = BezierSpline" not in text


def test_scale_stays_uniform_without_scaley() -> None:
    """No scaley signal, no pair: pixel scaleY params stay on the mask."""
    text = spec_to_comp(_spec())["text"]
    assert "XSize" not in text
    assert "UseSizeAndAspect" not in text


def test_static_scaley_param_splits_size() -> None:
    spec = _spec()
    title = next(layer for layer in spec["layers"] if layer["id"] == "title")
    title["params"]["scaleY"] = 1.2
    text = spec_to_comp(spec)["text"]
    assert "UseSizeAndAspect = Input { Value = 0, }" in text
    assert "XSize = Input { Value = 1, }" in text
    assert "YSize = Input { Value = 1.2, }" in text


def test_macro_publishes_controls_and_installs_template(tmp_path: Path) -> None:
    rendered = spec_to_macro(_spec())
    assert "MacroOperator" in rendered["text"]
    assert rendered["text"].count("{") == rendered["text"].count("}")
    assert rendered["skipped"] == []
    published = {(c["id"], c["source"]) for c in rendered["published"]}
    assert ("ball-color", "TopLeftRed") in published
    assert ("title-text", "StyledText") in published
    result = install_title_template(_spec(), dest_dir=tmp_path)
    path = Path(result["path"])
    assert path.name == "chair_bounce-title.setting"
    assert "MacroOperator" in path.read_text()


def test_macro_falls_back_for_shader() -> None:
    spec = _spec()
    spec["layers"][0]["type"] = "shader"
    assert spec_to_macro(spec)["fallback"]["capability"] == "fusionMacro"


def test_add_effect_round_trips_non_ascii_text(tmp_path: Path) -> None:
    """Live bug: an em-dash in model text crashed comp write without utf-8."""
    spec = _spec()
    title = next(layer for layer in spec["layers"] if layer["id"] == "title")
    title["params"]["string"] = " Jos — Chérie "
    item = FakeItem()
    op = add_effect(item, spec, cache_dir=tmp_path)
    assert item.imported == []
    text_tool = item.comps[op["comp_name"]].FindTool("Text_title")
    assert text_tool.values["StyledText"] == " Jos — Chérie "
    assert op["comp_name"] == "Comp 2"


def test_manifest_declares_fusion_macro_fallback() -> None:
    assert MANIFEST.capabilities.fusion_macros is True
    assert MANIFEST.fallbacks["fusionMacros"] != ""


def test_manifest_declares_api_builds() -> None:
    assert MANIFEST.capabilities.fusion_build_api is True
    assert MANIFEST.fallbacks["fusionBuild"] != ""


def test_add_effect_builds_new_comp_and_undo_switches_back(tmp_path: Path) -> None:
    FakeComp = _FAKES["FakeComp"]
    item = FakeItem()
    item.comps["Comp 1"] = FakeComp()  # previous comp already has a frame
    op = add_effect(item, _spec(), cache_dir=tmp_path)
    assert item.imported == []  # build-by-API writes no .comp file
    assert list(tmp_path.iterdir()) == []
    assert op["built_by"] == "api"
    assert op["comp_path"] is None
    assert op["comp_name"] == "Comp 2"
    assert op["prev_comp_name"] == "Comp 1"
    assert remove_effect(item, op) is True
    assert item.loaded == ["Comp 1"]
    assert item.deleted == []


def test_remove_effect_removes_the_added_version_without_a_frame(tmp_path: Path) -> None:
    """No framed previous comp: undo deletes the added version, never loads (#290)."""
    item = FakeItem()
    op = add_effect(item, _spec(), cache_dir=tmp_path)
    assert remove_effect(item, op) is True
    assert item.loaded == []
    assert item.deleted == ["Comp 2"]
    assert item.GetFusionCompNameList() == ["Comp 1"]


def test_remove_effect_fallback_is_a_noop() -> None:
    item = FakeItem()
    assert remove_effect(item, {"effect_id": "fx-1", "fallback": {}}) is True
    assert item.loaded == [] and item.deleted == []


def test_remove_effect_unwinds_when_delete_is_refused() -> None:
    """Sole version: delete refused, so the build group is undone (#295)."""
    FakeComp = _FAKES["FakeComp"]
    item = FakeItem()  # sole version: names == ["Comp 1"]
    comp = FakeComp()
    comp.StartUndo("chair build")
    comp.AddTool("Background")
    item.comps["Comp 1"] = comp
    op = {"comp_name": "Comp 1", "prev_comp_name": None,
          "undo": {"prev_comp_name": None}}
    assert remove_effect(item, op) is True
    assert item.loaded == []
    assert item.deleted == ["Comp 1"]  # tried, refused, fell through
    assert item.GetFusionCompNameList() == ["Comp 1"]
    assert len(comp.GetToolList(False)) == 2  # bare version stands


def test_remove_effect_fails_without_any_undo() -> None:
    import types

    item = FakeItem()  # sole version: names == ["Comp 1"]
    item.comps["Comp 1"] = types.SimpleNamespace()  # no Undo, no tools
    op = {"comp_name": "Comp 1", "prev_comp_name": None,
          "undo": {"prev_comp_name": None}}
    assert remove_effect(item, op) is False
    assert item.loaded == []


def test_add_effect_import_fast_path_when_ingested(tmp_path: Path) -> None:
    """Opt-in fast path: a working import keeps the old file behavior."""
    spec = _spec()
    title = next(layer for layer in spec["layers"] if layer["id"] == "title")
    title["params"]["string"] = " Jos — Chérie "
    item = FakeItem(ingest_broken=False)
    op = add_effect(item, spec, cache_dir=tmp_path, use_import=True)
    assert len(item.imported) == 1
    assert item.imported[0].startswith(str(tmp_path))
    assert "chair_" in item.imported[0] and item.imported[0].endswith(".comp")
    assert "/media/" not in item.imported[0]  # never next to source media
    text = Path(item.imported[0]).read_text(encoding="utf-8")
    assert "Jos — Chérie" in text
    assert text.count("{") == text.count("}")
    assert op["built_by"] == "import"
    assert op["comp_path"] == item.imported[0]
    assert op["comp_name"] == "Comp 2"


def test_add_effect_falls_back_to_build_when_import_ingests_nothing(
    tmp_path: Path,
) -> None:
    """Studio 21.1 live behavior: the import lands nothing, the API builds."""
    item = FakeItem(ingest_broken=True)
    op = add_effect(item, _spec(), cache_dir=tmp_path, use_import=True)
    assert len(item.imported) == 1  # the fast path was attempted
    assert item.deleted == ["Comp 2"]  # its dud version is dropped
    assert op["built_by"] == "api"
    assert op["comp_name"] == "Comp 2"
    assert op["prev_comp_name"] == "Comp 1"
    assert item.comps["Comp 2"].FindTool("Merge_title") is not None


def test_add_effect_falls_back_when_import_adds_no_version(tmp_path: Path) -> None:
    """Sweep #2: tools without a version name still fall back to the build."""

    class _UnnamedItem(FakeItem):
        def ImportFusionComp(self, path: str):
            comp = _FAKES["FakeComp"]()
            comp.AddTool("Background")
            comp.AddTool("Merge")
            comp.AddTool("Transform")
            self.imported.append(path)
            return comp

    item = _UnnamedItem()
    op = add_effect(item, _spec(), cache_dir=tmp_path, use_import=True)
    assert op["built_by"] == "api"
    assert op["comp_name"] == "Comp 2"


def _look_spec(look: str, params: dict | None = None) -> dict:
    spec = _spec()
    layer: dict = {"id": "look", "type": "shader", "params": {"look": look}}
    if params:
        layer["params"].update(params)
    spec["layers"].append(layer)
    return spec


def test_native_looks_map_to_fusion_tools() -> None:
    cases = [
        ("film-grain", {"amount": 0.7},
         ["Grain_look = FilmGrain", "MasterStrength"], "native:FilmGrain"),
        ("dither", {"levels": 4},
         ["Dith_look = Custom", "NumberIn1", "mod(x,2)"], "native:Custom(dither)"),
        ("halftone", {}, ["Halo_look = Custom", "cos(n2)"], "native:Custom(halftone)"),
        ("fast-noise", {}, ["FNoise_look = FastNoise", "Detail"], "native:FastNoise"),
        ("gradient", {"colors": ["#1a1d24", "#05070c"]},
         ["GWash_look = Background", 'FuID { "Gradient", }'], "native:Background(gradient)"),
        ("glow", {"gain": 1.5}, ["LGlow_look = SoftGlow", "Gain"], "native:SoftGlow"),
    ]
    for look, params, fragments, path in cases:
        rendered = spec_to_comp(_look_spec(look, params))
        assert "fallback" not in rendered, look
        text = rendered["text"]
        assert text.count("{") == text.count("}"), look
        for fragment in fragments:
            assert fragment in text, (look, fragment)
        assert rendered["paths"] == {"look": path}, look


def test_dither_levels_stay_keyframable() -> None:
    spec = _look_spec("dither", {"levels": 4})
    layer = next(layer for layer in spec["layers"] if layer["id"] == "look")
    layer["curves"] = {"levels": {"keyframes": [
        {"time": 0, "value": 4},
        {"time": 1, "value": 2},
    ]}}
    text = spec_to_comp(spec)["text"]
    assert [frame for frame, _ in _key_frames(text, "Dith_lookNumberIn1")] == [0, 30]


def test_dither_rejects_fewer_than_two_levels() -> None:
    assert check_spec(_look_spec("dither", {"levels": 1})) != []
    spec = _look_spec("dither", {"levels": 4})
    layer = next(layer for layer in spec["layers"] if layer["id"] == "look")
    layer["curves"] = {"levels": {"keyframes": [{"time": 0, "value": 1}]}}
    assert any(">= 2" in reason for reason in check_spec(spec))


def test_baked_sequence_loads_through_loader(tmp_path: Path) -> None:
    spec = _spec()
    spec["layers"].append({"id": "wash", "type": "shader", "params": {}})
    frame = tmp_path / "take_00000.png"
    frame.write_bytes(b"\x89PNG\r\n\x1a\n")
    sequences = {"wash": {"files": [str(frame)]}}
    assert check_spec(spec) != []
    assert check_spec(spec, sequences) == []
    rendered = spec_to_comp(spec, sequences=sequences)
    assert "fallback" not in rendered
    assert f'Filename = "{frame}"' in rendered["text"]
    assert "Length = 1" in rendered["text"]
    assert rendered["paths"] == {"wash": "baked:Loader"}
    item = FakeItem()
    op = add_effect(item, spec, cache_dir=tmp_path, sequences=sequences)
    assert op["paths"] == {"wash": "baked:Loader"}
    assert item.imported == []
    seq = item.comps[op["comp_name"]].FindTool("Seq_wash")
    assert seq.values["Clip"] == str(frame)


def test_macro_falls_back_for_footage_processing_look() -> None:
    assert spec_to_macro(_look_spec("dither"))["fallback"]["capability"] == "fusionMacro"
    rendered = spec_to_macro(_look_spec("gradient", {"colors": ["#111111", "#000000"]}))
    assert "fallback" not in rendered
    assert "GWash_look = Background" in rendered["text"]


def test_add_effect_falls_back_without_building(tmp_path: Path) -> None:
    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader"})
    item = FakeItem()
    op = add_effect(item, spec, cache_dir=tmp_path)
    assert op["fallback"]["capability"] == "fusionMacro"
    assert item.imported == []
    assert item.names == ["Comp 1"]  # no version was created
    assert remove_effect(item, op) is True  # nothing to undo


def test_load_effect_spec_inline_and_ref(tmp_path: Path) -> None:
    spec = _spec()
    assert load_effect_spec({"effect_id": "fx", "spec": spec}) == spec
    ref = tmp_path / "fx.effect.json"
    ref.write_text(json.dumps(spec))
    assert load_effect_spec({"effect_id": "fx", "spec_ref": str(ref)})["id"] == "bounce-title"


def _spec_timeline(effects: list[dict]) -> dict:
    return {
        "id": "tl",
        "name": "Fusion cut",
        "rate": {"num": 30, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "id": "c1",
                        "name": "c1",
                        "mediaRef": "/media/c.mov",
                        "sourceRange": {
                            "start": {"value": 0, "rate": 30},
                            "duration": {"value": 90, "rate": 30},
                        },
                        "timelineRange": {
                            "start": {"value": 0, "rate": 30},
                            "duration": {"value": 90, "rate": 30},
                        },
                        "effects": effects,
                    }
                ],
            }
        ],
        "markers": [],
    }


def _write_timeline_with_spec(tmp_path: Path, effects: list[dict]):
    import types

    from chair_resolve.write import plan_from_timeline, write_timeline

    timeline = _spec_timeline(effects)
    plan = plan_from_timeline(timeline)
    item = FakeItem()

    class _FakeTimeline:
        def SetSettings(self, settings: dict) -> bool:
            return True

        def GetTrackCount(self, track_type: str) -> int:
            return 1

        def AddTrack(self, track_type: str) -> bool:
            return True

        def SetTrackName(self, *args) -> bool:
            return True

        def AddMarker(self, *args) -> bool:
            return True

    class _FakePool:
        def ImportMedia(self, clips: list) -> list:
            return [object() for _ in clips]

        def CreateEmptyTimeline(self, name: str):
            return _FakeTimeline()

        def AppendToTimeline(self, clips: list) -> list:
            return [item for _ in clips]

    project = types.SimpleNamespace(
        GetMediaPool=lambda: _FakePool(),
        SetCurrentTimeline=lambda timeline: True,
    )
    resolve = types.SimpleNamespace(
        GetProjectManager=lambda: types.SimpleNamespace(GetCurrentProject=lambda: project)
    )
    summary = write_timeline(timeline, resolve=resolve, fusion_cache_dir=tmp_path)
    return plan, summary, item


def test_spec_effect_plans_and_builds(tmp_path: Path) -> None:
    plan, summary, item = _write_timeline_with_spec(
        tmp_path,
        [{"id": "fx-title", "presetName": "Bounce", "params": {"spec": _spec()}}],
    )
    assert plan["fusion"] == [
        {
            "clip_id": "c1",
            "effect_id": "fx-title",
            "preset": "Bounce",
            "kind": "effect-spec",
            "spec": _spec(),
        }
    ]
    assert summary["fusion"] == 1
    assert summary["skipped"] == 0
    assert item.imported == []
    assert len(item.built) == 1


def test_shader_spec_skips_with_rendered_clip_fallback(tmp_path: Path) -> None:
    from chair_resolve.write import _import_planned_fusion, plan_from_timeline

    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader"})
    timeline = _spec_timeline(
        [{"id": "fx-shader", "presetName": "Shader", "params": {"spec": spec}}]
    )
    plan = plan_from_timeline(timeline)
    item = FakeItem()
    assert _import_planned_fusion(plan, MANIFEST, item, plan["fusion"][0], tmp_path) is False
    assert item.imported == []
    assert plan["skipped"][0]["id"] == "fx-shader"
    assert MANIFEST.fallbacks["fusionMacros"] in plan["skipped"][0]["reason"]

    _plan, summary, item2 = _write_timeline_with_spec(
        tmp_path,
        [{"id": "fx-shader", "presetName": "Shader", "params": {"spec": spec}}],
    )
    assert summary["fusion"] == 0
    assert summary["skipped"] == 1
    assert item2.imported == []
