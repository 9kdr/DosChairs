import json
import re
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


def test_manifest_declares_fusion_macro_fallback() -> None:
    assert MANIFEST.capabilities.fusion_macros is True
    assert MANIFEST.fallbacks["fusionMacros"] != ""


class _FakeFusionItem:
    def __init__(self) -> None:
        self.names = ["Comp 1"]
        self.imported: list[str] = []
        self.loaded: list[str] = []

    def GetFusionCompNameList(self) -> list[str]:
        return list(self.names)

    def ImportFusionComp(self, path: str):
        self.imported.append(path)
        self.names.append(f"Comp {len(self.names) + 1}")
        return object()

    def LoadFusionCompByName(self, name: str) -> bool:
        self.loaded.append(name)
        return True


def test_add_effect_imports_new_comp_and_undo_switches_back(tmp_path: Path) -> None:
    item = _FakeFusionItem()
    op = add_effect(item, _spec(), cache_dir=tmp_path)
    assert len(item.imported) == 1
    assert item.imported[0].startswith(str(tmp_path))
    assert "chair_" in item.imported[0] and item.imported[0].endswith(".comp")
    assert "/media/" not in item.imported[0]  # never next to source media
    assert op["comp_name"] == "Comp 2"
    assert op["prev_comp_name"] == "Comp 1"
    assert remove_effect(item, op) is True
    assert item.loaded == ["Comp 1"]


def test_add_effect_falls_back_without_importing(tmp_path: Path) -> None:
    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader"})
    item = _FakeFusionItem()
    op = add_effect(item, spec, cache_dir=tmp_path)
    assert op["fallback"]["capability"] == "fusionMacro"
    assert item.imported == []
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
    item = _FakeFusionItem()

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


def test_spec_effect_plans_and_imports(tmp_path: Path) -> None:
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
    assert len(item.imported) == 1


def test_shader_spec_skips_with_rendered_clip_fallback(tmp_path: Path) -> None:
    from chair_resolve.write import _import_planned_fusion, plan_from_timeline

    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader"})
    timeline = _spec_timeline(
        [{"id": "fx-shader", "presetName": "Shader", "params": {"spec": spec}}]
    )
    plan = plan_from_timeline(timeline)
    item = _FakeFusionItem()
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
