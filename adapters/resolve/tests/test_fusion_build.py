"""Tests for the API builder: layout, key tables, and builds on a fake comp."""

import re
import runpy
from pathlib import Path

import pytest
from chair_resolve.fusion import spec_to_comp, spec_to_plan
from chair_resolve.fusion_build import arrange, build_comp, layout_plan, spline_table
from chair_resolve.write import remove_effect

_FAKES = runpy.run_path(str(Path(__file__).with_name("fake_fusion.py")))
FakeComp = _FAKES["FakeComp"]
FakeItem = _FAKES["FakeItem"]

FIXTURE = Path(__file__).parents[3] / "fixtures" / "effects" / "bounce-title.effect.json"


def _spec() -> dict:
    import json

    return json.loads(FIXTURE.read_text())


def _spline_frames(text: str, tool: str) -> list[int]:
    block = re.search(rf"{re.escape(tool)} = BezierSpline \{{(.*?)\n\t\t\}}", text, re.S)
    assert block is not None, f"missing spline {tool}"
    return sorted(int(match.group(1)) for match in re.finditer(r"\[(\d+)\] = ", block.group(1)))


def test_layout_spine_with_side_row_above() -> None:
    plan = spec_to_plan(_spec())
    positions = layout_plan(plan)
    names = [tool["name"] for tool in plan["tools"]]
    assert names[0] == "MediaIn1" and names[-1] == "MediaOut1"
    assert positions["MediaIn1"] == (0, 0)
    assert positions["MediaOut1"][1] == 0
    assert positions["MediaOut1"][0] == max(x for x, _ in positions.values())
    placed = [t for t in plan["tools"] if t["role"] != "xpath"]
    assert len(set(positions.values())) == len(placed)  # nothing overlaps
    merges = [t for t in plan["tools"] if t["role"] == "merge"]
    assert [positions[m["name"]][1] for m in merges] == [0] * len(merges)
    merge_xs = [positions[m["name"]][0] for m in merges]
    assert merge_xs == sorted(merge_xs)  # spine runs left to right
    side = [t for t in plan["tools"] if t["role"] not in ("spine", "merge", "xpath")]
    assert {positions[t["name"]][1] for t in side} == {-2}  # one side row
    side_xs = [positions[t["name"]][0] for t in side]
    assert side_xs == sorted(side_xs)  # plan order reads left to right
    for merge in merges:  # each merge sits below its own transform
        xf = next(t for t in side if t["layer"] == merge["layer"] and t["role"] == "transform")
        assert positions[merge["name"]][0] == positions[xf["name"]][0]


def test_layout_skips_xpath_modifiers() -> None:
    """Live: a standalone XYPath carries no Pos on export, so no position."""
    plan = spec_to_plan(_spec())
    positions = layout_plan(plan)
    paths = [t["name"] for t in plan["tools"] if t["role"] == "xpath"]
    assert paths, "fixture has no xpath entry to exclude"
    assert not set(paths) & set(positions)


def test_layout_is_deterministic_and_ignores_positions() -> None:
    plan = spec_to_plan(_spec())
    assert layout_plan(plan) == layout_plan(spec_to_plan(_spec()))
    for tool in plan["tools"]:
        tool["pos"] = [999, 999]
        tool["x"] = 999
        tool["y"] = 999
    assert layout_plan(plan) == layout_plan(spec_to_plan(_spec()))


def test_layout_15_nodes_stays_bounded() -> None:
    tools = [{"name": "MediaIn1", "role": "spine", "layer": None}]
    for layer in range(4):
        lid = f"L{layer}"
        tools += [
            {"name": f"Bg_{lid}", "role": "source", "layer": lid},
            {"name": f"Xf_{lid}", "role": "transform", "layer": lid},
            {"name": f"Merge_{lid}", "role": "merge", "layer": lid},
        ]
    tools += [
        {"name": "Mask_L0", "role": "mask", "layer": "L0"},
        {"name": "MediaOut1", "role": "spine", "layer": None},
    ]
    assert len(tools) == 15
    positions = layout_plan({"tools": tools})
    assert len(set(positions.values())) == 15
    width = max(x for x, _ in positions.values()) - min(x for x, _ in positions.values())
    height = max(y for _, y in positions.values()) - min(y for _, y in positions.values())
    assert width <= 24  # about one Flow screen wide at rest zoom
    assert height <= 4  # spine plus side row, nothing sprawling


def test_rebuild_lays_full_graph_out_again() -> None:
    item = FakeItem()
    plan = spec_to_plan(_spec())
    first = build_comp(item, plan)
    second = build_comp(item, plan)
    assert first["layout"] is True and second["layout"] is True
    assert item.comps["Comp 2"].flow.positions == item.comps["Comp 3"].flow.positions


def test_spline_table_carries_easing_and_handles() -> None:
    table = spline_table([
        {"frame": 0, "value": 0.2, "lh": None, "rh": [3, 0.2], "easing": "linear"},
        {"frame": 18, "value": 0.8, "lh": [-3, -0.2], "rh": None, "easing": "hold"},
        {"frame": 30, "value": 0.5, "lh": None, "rh": None, "easing": "smooth"},
    ])
    assert table[0] == {1: 0.2, "RH": {1: 3, 2: 0.2}, "Flags": {"Linear": True}}
    assert table[18] == {1: 0.8, "LH": {1: -3, 2: -0.2}, "Flags": {"StepIn": True}}
    assert table[30] == {1: 0.5}


def test_spline_table_holds_first_value_at_frame_zero() -> None:
    table = spline_table([{"frame": 15, "value": 4, "lh": None, "rh": None}])
    assert table[0] == {1: 4}
    assert table[15][1] == 4


def test_plan_splines_match_text_frames() -> None:
    """Drift guard: the plan animates exactly what the .comp text animates."""
    spec = _spec()
    text = spec_to_comp(spec)["text"]
    plan = spec_to_plan(spec)
    assert plan["tools"], "plan is empty"
    seen = 0
    for tool in plan["tools"]:
        for input_id, keys in tool["splines"].items():
            frames = [key["frame"] for key in keys]
            assert _spline_frames(text, f"{tool['name']}{input_id}") == sorted(frames)
            seen += 1
    assert seen >= 3  # X, Y, and a Blend spline at least


def test_plan_connections_reference_known_tools() -> None:
    plan = spec_to_plan(_spec())
    names = {tool["name"] for tool in plan["tools"]}
    connections = [
        (tool["name"], input_id, src)
        for tool in plan["tools"]
        for input_id, (src, _output) in tool["connect"].items()
    ]
    assert connections, "plan has no connections"
    for _dst, _input_id, src in connections:
        assert src in names


def test_plan_falls_back_like_comp() -> None:
    spec = _spec()
    spec["layers"].append({"id": "evil", "type": "shader"})
    plan = spec_to_plan(spec)
    assert plan["fallback"]["capability"] == "fusionMacro"
    assert "tools" not in plan


def test_build_lands_on_new_version_with_report() -> None:
    item = FakeItem()
    before = item.AddFusionComp()
    before_count = len(before.GetToolList(False))
    plan = spec_to_plan(_spec())
    op = build_comp(item, plan)
    assert op["comp_name"] == "Comp 3"
    assert op["prev_comp_name"] == "Comp 2"
    assert op["built_by"] == "api"
    assert op["undo"] == {"prev_comp_name": "Comp 2"}
    assert len(before.GetToolList(False)) == before_count  # untouched
    comp = item.comps["Comp 3"]
    assert op["tool_count"] == len(comp.GetToolList(False))
    assert op["tools"][0] == "MediaIn1" and op["tools"][-1] == "MediaOut1"
    assert ["Merge_bg", "Background", "MediaIn1", "Output"] in op["connections"]
    assert ["MediaOut1", "Input", "Merge_title", "Output"] in op["connections"]
    assert op["layout"] is True
    placed = {t["name"] for t in plan["tools"] if t["role"] != "xpath"}
    assert set(comp.flow.positions) == placed
    assert comp.locked is False
    assert comp.undo_log[0] == "chair build" and comp.undo_log[-1] == ("end", True)
    assert remove_effect(item, op) is True
    assert item.loaded == ["Comp 2"]


def test_build_without_layout_skips_flow() -> None:
    item = FakeItem()
    op = build_comp(item, spec_to_plan(_spec()), layout=False)
    assert op["layout"] is False
    assert item.comps["Comp 2"].flow.positions == {}


def test_build_starts_from_edit_page() -> None:
    """Live: comp calls answered from the Color page are duds."""
    import types

    pages: list[str] = []
    resolve = types.SimpleNamespace(OpenPage=lambda page: pages.append(page))
    build_comp(FakeItem(), spec_to_plan(_spec()), resolve=resolve)
    assert pages[0] == "edit"


def _rich_spec() -> dict:
    spec = _spec()
    spec["layers"].append({
        "id": "dither", "type": "shader", "blend": "screen",
        "params": {"look": "dither", "levels": 4},
        "curves": {"levels": {"keyframes": [
            {"time": 0, "value": 4}, {"time": 1, "value": 2},
        ]}},
    })
    spec["layers"].append({
        "id": "wash", "type": "shader",
        "params": {"look": "gradient", "colors": ["#1a1d24", "#05070c"]},
    })
    spec["layers"].append({
        "id": "still", "type": "image", "params": {"src": "/media/still.png"},
    })
    return spec


def test_build_sets_values_connections_and_positions() -> None:
    item = FakeItem()
    plan = spec_to_plan(_rich_spec())
    op = build_comp(item, plan)
    comp = item.comps[op["comp_name"]]
    placed = {t["name"] for t in plan["tools"] if t["role"] != "xpath"}
    assert set(comp.flow.positions) == placed

    def tool(name: str):
        found = comp.FindTool(name)
        assert found is not None, f"missing tool {name}"
        return found

    dith = tool("Dith_dither")
    assert "mod(x,2)" in dith.values["RedExpression"]
    assert dith.values["NameforNumber1"] == "Levels"
    assert dith.values["AlphaExpression"] == "a1"
    assert dith.connected["Image1"][0] == "Merge_title"
    assert "Dith_ditherNumberIn1" in op["keyframes"]
    assert op["keyframes"]["Dith_ditherNumberIn1"] == 2

    title = tool("Text_title")
    assert title.values["StyledText"] != ""
    assert title.values["Style"] == "Bold"

    bg = tool("Bg_bg")
    assert bg.values["Width"] == 1920 and bg.values["Height"] == 1080
    assert bg.connected["EffectMask"] == ("Mask_bg", "Mask")
    assert tool("Mask_bg").values["Center"] == {"X": 0.5, "Y": 0.5}

    merge = tool("Merge_dither")
    assert merge.values["ApplyMode"] == "Screen"
    assert merge.connected["Background"] == ("Merge_title", "Output")
    assert merge.connected["Foreground"][0] == "Xf_dither"

    wash = tool("GWash_wash")
    assert wash.values["Type"] == "Gradient"
    top = wash.GetInput("Gradient").Value[0]
    assert (top[1], top[2], top[3]) != (0.0, 0.0, 0.0)

    img = tool("Img_still")
    assert img.values["Clip"] == "/media/still.png"

    out = tool("MediaOut1")
    assert out.connected["Input"] == ("Merge_still", "Output")

    xf = tool("Xf_ball")
    assert xf.connected["Center"] == ("Xf_ballXY", "Value")
    assert op["keyframes"]["Xf_ballXYY"] == 8
    assert op["keyframes"]["Xf_ballXYX"] == 2


def test_build_writes_squash_pair() -> None:
    """Sweep #8: scaley rides the Transform's YSize, X stays put."""
    spec = _spec()
    title = next(layer for layer in spec["layers"] if layer["id"] == "title")
    title["curves"] = {"scaley": {"keyframes": [
        {"time": 0, "value": 1},
        {"time": 1, "value": 0.8},
    ]}}
    item = FakeItem()
    op = build_comp(item, spec_to_plan(spec))
    assert op["keyframes"]["Xf_titleYSize"] == 2
    assert "Xf_titleSize" not in op["keyframes"]
    xf = item.comps[op["comp_name"]].FindTool("Xf_title")
    assert xf.values["UseSizeAndAspect"] == 0
    assert xf.values["XSize"] == 1


def test_build_absorbs_modifier_seed_key() -> None:
    """A curve starting after 0 still lands exactly: the seed is overwritten."""
    spec = _spec()
    ball = next(layer for layer in spec["layers"] if layer["id"] == "ball")
    ball["curves"] = {"y": {"keyframes": [
        {"time": 0.5, "value": 100}, {"time": 1.0, "value": 200},
    ]}}
    item = FakeItem()
    op = build_comp(item, spec_to_plan(spec))
    assert op["keyframes"]["Xf_ballXYY"] == 3  # frames 0, 15, 30
    spline = item.comps[op["comp_name"]].FindTool("Xf_ballXYY")
    assert sorted(spline.keys) == [0, 15, 30]
    assert spline.keys[0] == {1: spline.keys[15][1]}


def _item_with(comp_cls):
    class _CustomItem(FakeItem):
        def AddFusionComp(self):
            comp = comp_cls()
            self.names.append(f"Comp {len(self.names) + 1}")
            self.comps[self.names[-1]] = comp
            self.built.append(comp)
            return comp

    return _CustomItem()


def test_build_fails_when_no_comp_created() -> None:
    """Sweep #2: never report success on a no-op."""

    class _NoCompItem(FakeItem):
        def AddFusionComp(self):
            return None

    with pytest.raises(RuntimeError, match="did not create"):
        build_comp(_NoCompItem(), spec_to_plan(_spec()))


def test_build_fails_when_version_list_does_not_grow() -> None:
    """Sweep #2: no new name, no success report."""

    class _FrozenNamesItem(FakeItem):
        def AddFusionComp(self):
            comp = FakeComp()
            self.built.append(comp)
            return comp

    with pytest.raises(RuntimeError, match="did not add a comp version"):
        build_comp(_FrozenNamesItem(), spec_to_plan(_spec()))


def test_build_fails_when_tool_goes_missing() -> None:
    """Sweep #2: count and name check after the build."""

    class _DroppingComp(FakeComp):
        def FindTool(self, name):
            if name == "Merge_bg":
                return None
            return super().FindTool(name)

    with pytest.raises(RuntimeError, match="dropped 1 tool.*Merge_bg"):
        build_comp(_item_with(_DroppingComp), spec_to_plan(_spec()))


def test_build_fails_when_add_tool_refused() -> None:
    class _RefusingComp(FakeComp):
        def AddTool(self, registry):
            if registry == "Merge":
                return None
            return super().AddTool(registry)

    with pytest.raises(RuntimeError, match="could not add tool"):
        build_comp(_item_with(_RefusingComp), spec_to_plan(_spec()))


def test_arrange_needs_a_frame() -> None:
    import types

    item = FakeItem()
    assert arrange(object(), item, "Comp 9", {}, {}, None) is False
    opened: list[str] = []
    resolve = types.SimpleNamespace(OpenPage=lambda page: opened.append(page))
    assert arrange(object(), item, "Comp 9", {}, {}, resolve) is False
    assert opened == []  # never forces the Fusion page open (#290)
    assert item.loaded == []  # and never loads the comp to reach a frame
    comp = FakeComp()
    tools = {"MediaIn1": comp.FindTool("MediaIn1")}
    assert arrange(comp, item, "Comp 1", tools, {"MediaIn1": (0, 0)}, None) is True
    assert comp.flow.positions == {"MediaIn1": (0, 0)}
    assert comp.flow.framed is True


def test_arrange_reports_unlanded_positions() -> None:
    FakeFlow = _FAKES["FakeFlow"]

    class _LyingFlow(FakeFlow):
        def GetPos(self, tool):
            return 999.0

    comp = FakeComp()
    comp.flow = _LyingFlow()
    tools = {"MediaIn1": comp.FindTool("MediaIn1")}
    assert arrange(comp, FakeItem(), "Comp 1", tools, {"MediaIn1": (0, 0)}, None) is False


def test_arrange_tolerates_small_readback_offsets() -> None:
    """Live: masks read back ~0.07 grid off (their node anchors differ)."""
    FakeFlow = _FAKES["FakeFlow"]

    class _OffsetFlow(FakeFlow):
        def GetPos(self, tool):
            return super().GetPos(tool) + 0.07

    comp = FakeComp()
    comp.flow = _OffsetFlow()
    tools = {"MediaIn1": comp.FindTool("MediaIn1")}
    assert arrange(comp, FakeItem(), "Comp 1", tools, {"MediaIn1": (0, 0)}, None) is True
