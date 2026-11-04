"""Build a spec_to_plan node graph on a NEW Fusion comp through the API.

ImportFusionComp ingests nothing on Mel's Studio 21.1, even for comps
Resolve made itself (see #266), so generated pieces reach Resolve
tool-by-tool: AddFusionComp for a fresh comp version (the user's existing
comps are never touched), then AddTool, SetInput, ConnectInput, and
AddModifier with BezierSpline keys, all inside Lock/Unlock and an undo
group. layout_plan arranges the Flow view left-to-right afterwards.

Only this module talks to a live Fusion comp. Everything else here is
pure so the layout and the key tables stay unit-testable on fakes.
"""

from __future__ import annotations

from typing import Any

LAYOUT_DX = 2
# Flow rows in FlowView grid units (measured live: 1 x-unit is 110
# Pos-pixels, 1 y-unit is 33, off the (55, 16) origin; a node fills
# exactly 1x1). The spine (media + merges) runs left to right at y=0,
# each node kind gets its own lane, and every tool gets its own column
# with a column to spare, so no two nodes can overlap.
LANE_Y = {
    "spine": 0,
    "merge": 0,
    "source": -4,
    "look": -4,
    "mask": -8,
    "transform": 4,
    "xpath": 6,
    "fx": 8,
}


def layout_plan(plan: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """Plan tools -> Flow positions. Pure: column per tool, lane per role."""
    positions: dict[str, tuple[int, int]] = {}
    for index, tool in enumerate(plan["tools"]):
        positions[tool["name"]] = (index * LAYOUT_DX, LANE_Y.get(tool.get("role", ""), 0))
    return positions


def spline_table(keys: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Plan keys -> one SetKeyFrames table.

    SetKeyFrames merges into the spline (it never deletes), and AddModifier
    seeds a key at frame 0, so the table always carries frame 0: curves
    that start later get a hold of their first value there, which matches
    how a spline behaves before its first key.
    """
    table: dict[int, dict[str, Any]] = {}
    for key in sorted(keys, key=lambda k: k["frame"]):
        cell: dict[str, Any] = {1: key["value"]}
        if key.get("lh") is not None:
            cell["LH"] = {1: key["lh"][0], 2: key["lh"][1]}
        if key.get("rh") is not None:
            cell["RH"] = {1: key["rh"][0], 2: key["rh"][1]}
        easing = key.get("easing", "linear")
        if easing == "linear":
            cell["Flags"] = {"Linear": True}
        elif easing == "hold":
            cell["Flags"] = {"StepIn": True}
        table[key["frame"]] = cell
    if table and 0 not in table:
        table[0] = {1: table[min(table)][1]}
    return table


def current_comp_name(item: Any, names: list[str]) -> str | None:
    """The item's current comp name, or the last known one. Pure-ish."""
    current_fn = getattr(item, "GetCurrentFusionComp", None)
    current = current_fn() if callable(current_fn) else None
    if current is not None:
        attrs = getattr(current, "GetAttrs", lambda: {})()
        if isinstance(attrs, dict) and attrs.get("COMPS_Name"):
            return str(attrs["COMPS_Name"])
    return names[-1] if names else None


def comp_names(item: Any) -> list[str]:
    """GetFusionCompNameList as a list (it answers {} when there are none)."""
    return list(getattr(item, "GetFusionCompNameList", lambda: [])() or [])


def tool_count(comp: Any) -> int:
    """Tools on a comp. A bare new comp holds MediaIn + MediaOut."""
    tools = comp.GetToolList(False) or {}
    return len(tools)


def _call(comp: Any, name: str, *args: Any) -> Any:
    fn = getattr(comp, name, None)
    return fn(*args) if callable(fn) else None


def _tool_ids(comp: Any) -> dict[Any, Any]:
    try:
        return dict(comp.GetToolList(False) or {})
    except Exception:
        return {}


def build_comp(
    item: Any,
    plan: dict[str, Any],
    resolve: Any = None,
    layout: bool = True,
) -> dict[str, Any]:
    """Build the plan on a NEW comp version of the item. Returns a report.

    Passes: create every tool (existing spine entries are found, never
    added), set values, connect inputs, then animate. resolve is only
    needed to reach the Fusion page for layout; without it the build
    still lands and the report says the layout was skipped.
    """
    before = comp_names(item)
    prev = current_comp_name(item, before)
    if resolve is not None:
        # Comp calls answered from another page are duds (AddFusionComp
        # returns None on the Color page), so start from the Edit page.
        try:
            resolve.OpenPage("edit")
        except Exception:
            pass
    comp = item.AddFusionComp()
    if comp is None:
        raise RuntimeError("Studio did not create a new Fusion comp version.")
    after = comp_names(item)
    added = [name for name in after if name not in before]
    if not added:
        raise RuntimeError(
            "Studio did not add a comp version for this build: the version "
            "list did not grow, so there is nothing to undo to."
        )
    comp_name = added[-1]
    tools_before = tool_count(comp)
    _call(comp, "Lock")
    _call(comp, "StartUndo", "chair build")
    try:
        tools: dict[str, Any] = {}
        for entry in plan["tools"]:
            if entry.get("existing"):
                found = comp.FindTool(entry["name"])
                if found is None:
                    raise RuntimeError(
                        f"Fresh comp {comp_name!r} has no {entry['name']}."
                    )
                tools[entry["name"]] = found
            else:
                tool = comp.AddTool(entry["tool"])
                if tool is None:
                    raise RuntimeError(
                        f"Studio could not add tool {entry['tool']!r} "
                        f"({entry['name']})."
                    )
                tool.SetAttrs({"TOOLS_Name": entry["name"]})
                tools[entry["name"]] = tool
        for entry in plan["tools"]:
            _set_values(tools[entry["name"]], entry)
        connections: list[list[str]] = []
        for entry in plan["tools"]:
            tool = tools[entry["name"]]
            for input_id, (src, output) in entry["connect"].items():
                if not tool.ConnectInput(input_id, getattr(tools[src], output)):
                    raise RuntimeError(
                        f"Studio would not connect {entry['name']}.{input_id} "
                        f"to {src}.{output}."
                    )
                connections.append([entry["name"], input_id, src, output])
        keyframes: dict[str, int] = {}
        for entry in plan["tools"]:
            tool = tools[entry["name"]]
            for input_id, keys in entry["splines"].items():
                spline = _add_spline(comp, tool, entry["name"], input_id)
                table = spline_table(keys)
                spline.SetKeyFrames(table)
                attrs = spline.GetAttrs() or {}
                keyframes[str(attrs.get("TOOLS_Name", f"{entry['name']}{input_id}"))] = (
                    len(table)
                )
        positions = layout_plan(plan) if layout else {}
        arranged = (
            arrange(comp, item, comp_name, tools, positions, resolve) if layout else False
        )
        _prove_landed(comp, plan, tools_before)
    finally:
        _call(comp, "EndUndo", True)
        _call(comp, "Unlock")
    return {
        "comp_name": comp_name,
        "prev_comp_name": prev,
        "undo": {"prev_comp_name": prev},
        "paths": plan.get("paths", {}),
        "built_by": "api",
        "tool_count": tool_count(comp),
        "tools": [entry["name"] for entry in plan["tools"]],
        "connections": connections,
        "keyframes": keyframes,
        "layout": arranged,
    }


def _prove_landed(comp: Any, plan: dict[str, Any], tools_before: int) -> None:
    """Fail loudly when the build landed nothing. Never a quiet no-op."""
    tools_after = tool_count(comp)
    if tools_after <= tools_before:
        raise RuntimeError(
            f"Studio built no tools: the comp still holds {tools_after} "
            f"(nothing was added)."
        )
    missing = [
        entry["name"] for entry in plan["tools"] if comp.FindTool(entry["name"]) is None
    ]
    if missing:
        raise RuntimeError(
            f"Studio dropped {len(missing)} tools: {', '.join(missing)}."
        )


def _set_values(tool: Any, entry: dict[str, Any]) -> None:
    for input_id, value in entry["values"].items():
        if isinstance(value, list):
            value = {"X": value[0], "Y": value[1]}
        tool.SetInput(input_id, value)
    for input_id, stops in entry["gradient"].items():
        grad = tool.GetInput(input_id)
        grad.Value = {
            stop[0]: {1: stop[1], 2: stop[2], 3: stop[3], 4: stop[4]} for stop in stops
        }


def _tool_name(tool: Any) -> str:
    try:
        attrs = tool.GetAttrs() or {}
    except Exception:
        return ""
    return str(attrs.get("TOOLS_Name", ""))


def _add_spline(comp: Any, tool: Any, tool_name: str, input_id: str) -> Any:
    """Animate one input; return the modifier spline AddModifier created.

    Found by name, not by tool-list position: GetToolList keys shift
    between calls, but the spline is always the one newcomer, usually
    named {tool}{input} (XYPath variants gain a numeric suffix).
    """
    known = {_tool_name(existing) for existing in _tool_ids(comp).values()}
    tool.AddModifier(input_id, "BezierSpline")
    newcomers = [
        cand
        for cand in _tool_ids(comp).values()
        if _tool_name(cand) and _tool_name(cand) not in known
    ]
    if not newcomers:
        raise RuntimeError(f"AddModifier added no spline for {input_id}.")
    prefix = f"{tool_name}{input_id}"
    for cand in newcomers:
        if _tool_name(cand).startswith(prefix):
            return cand
    return newcomers[0]


def arrange(
    comp: Any,
    item: Any,
    comp_name: str | None,
    tools: dict[str, Any],
    positions: dict[str, tuple[int, int]],
    resolve: Any = None,
) -> bool:
    """Set Flow positions. True only when every node landed."""
    frame = getattr(comp, "CurrentFrame", None)
    if frame is None and resolve is not None:
        try:
            resolve.OpenPage("fusion")
        except Exception:
            return False
        frame = getattr(comp, "CurrentFrame", None)
    if frame is None and comp_name is not None:
        loader = getattr(item, "LoadFusionCompByName", None)
        if callable(loader):
            try:
                comp = loader(comp_name) or comp
            except Exception:
                pass
            frame = getattr(comp, "CurrentFrame", None)
    flow = getattr(frame, "FlowView", None) if frame is not None else None
    if flow is None or not callable(getattr(flow, "SetPos", None)):
        return False
    can_read = callable(getattr(flow, "GetPos", None))
    ok = True
    for name, (x, y) in positions.items():
        tool = tools.get(name)
        if tool is None:
            ok = False
            continue
        try:
            flow.SetPos(tool, x, y)
            if can_read and abs(float(flow.GetPos(tool)) - x) > 1e-6:
                ok = False
        except Exception:
            ok = False
    frame_all = getattr(flow, "FrameAll", None)
    if callable(frame_all):
        try:
            frame_all()
        except Exception:
            pass
    return ok
