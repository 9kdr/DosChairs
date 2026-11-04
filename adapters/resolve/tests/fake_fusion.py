"""Live-parity fakes for the Fusion scripting API. Loaded via runpy.

Semantics verified on Mel's Studio 21.1 while building #270:
- a fresh comp holds MediaIn1 + MediaOut1 and CurrentTime 0
- AddTool names tools Registry1, Registry2, ... until renamed
- ConnectInput returns True; connected inputs read back None
- AddModifier seeds a key at frame 0 with the input's current value
- SetKeyFrames merges (it never deletes)
- GetFusionCompNameList answers {} when the item has no comps
- LoadFusionCompByName answers the comp object
"""

from __future__ import annotations

from typing import Any


class FakeGradient:
    def __init__(self) -> None:
        self.Value: dict[float, dict[int, float]] = {
            0.0: {1: 0.0, 2: 0.0, 3: 0.0, 4: 1.0},
            1.0: {1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0},
        }


class FakeSpline:
    """A BezierSpline modifier with merge-on-write keys."""

    def __init__(self, name: str) -> None:
        self._name = name
        self.keys: dict[int, dict[str, Any]] = {}

    def GetAttrs(self) -> dict[str, Any]:
        return {"TOOLS_Name": self._name}

    def SetKeyFrames(self, table: dict[int, dict[str, Any]]) -> None:
        self.keys.update(table)

    def GetKeyFrames(self) -> dict[int, dict[str, Any]]:
        return dict(self.keys)


class FakeTool:
    def __init__(self, comp: FakeComp, registry: str, name: str) -> None:
        self._comp = comp
        self._registry = registry
        self._name = name
        self.values: dict[str, Any] = {}
        self.connected: dict[str, tuple[str, str]] = {}
        self._gradient: FakeGradient | None = None

    def GetAttrs(self) -> dict[str, Any]:
        return {"TOOLS_Name": self._name}

    def SetAttrs(self, attrs: dict[str, Any]) -> None:
        if "TOOLS_Name" in attrs:
            self._name = str(attrs["TOOLS_Name"])

    def SetInput(self, input_id: str, value: Any) -> None:
        self.values[input_id] = value

    def GetInput(self, input_id: str) -> Any:
        if input_id in self.connected:
            return None
        if input_id == "Gradient":
            if self._gradient is None:
                self._gradient = FakeGradient()
            return self._gradient
        return self.values.get(input_id)

    def ConnectInput(self, input_id: str, output: tuple[FakeTool, str]) -> bool:
        src, out = output
        self.connected[input_id] = (src.GetAttrs()["TOOLS_Name"], out)
        return True

    def AddModifier(self, input_id: str, kind: str) -> bool:
        assert kind == "BezierSpline"
        spline = FakeSpline(f"{self._name}{input_id}")
        current = self.values.get(input_id, 0)
        if isinstance(current, dict):
            current = 0
        spline.keys[0] = {1: current}
        self._comp._add(spline)
        return True

    def __getattr__(self, output: str) -> tuple[FakeTool, str]:
        if output in ("Output", "Value", "Mask"):
            return (self, output)
        raise AttributeError(output)


class FakeFlow:
    def __init__(self) -> None:
        self.positions: dict[str, tuple[int, int]] = {}
        self.framed = False

    def SetPos(self, tool: FakeTool, x: int, y: int) -> None:
        self.positions[tool.GetAttrs()["TOOLS_Name"]] = (x, y)

    def GetPos(self, tool: FakeTool) -> float:
        return float(self.positions[tool.GetAttrs()["TOOLS_Name"]][0])

    def FrameAll(self) -> None:
        self.framed = True


class FakeFrame:
    def __init__(self, comp: FakeComp) -> None:
        self.FlowView = comp.flow


class FakeComp:
    """A fresh-comp-shaped Fusion comp: MediaIn1 + MediaOut1, frame 0."""

    def __init__(self) -> None:
        self._tools: dict[int, FakeTool | FakeSpline] = {}
        self._seq = 0
        self.flow = FakeFlow()
        self.locked = False
        self.undo_log: list[Any] = []
        self._add(FakeTool(self, "Loader", "MediaIn1"))
        self._add(FakeTool(self, "Saver", "MediaOut1"))

    def _add(self, tool: FakeTool | FakeSpline) -> FakeTool | FakeSpline:
        self._seq += 1
        self._tools[self._seq] = tool
        return tool

    @property
    def CurrentFrame(self) -> FakeFrame:
        return FakeFrame(self)

    def AddTool(self, registry: str) -> FakeTool:
        taken = sum(
            isinstance(tool, FakeTool) and tool._registry == registry
            for tool in self._tools.values()
        )
        tool = FakeTool(self, registry, f"{registry}{taken + 1}")
        self._add(tool)
        return tool

    def FindTool(self, name: str) -> FakeTool | FakeSpline | None:
        for tool in self._tools.values():
            if tool.GetAttrs().get("TOOLS_Name") == name:
                return tool
        return None

    def GetToolList(self, _selected: bool) -> dict[int, FakeTool | FakeSpline]:
        return dict(self._tools)

    def GetAttrs(self) -> dict[str, Any]:
        return {"COMPS_Name": "FakeComposition", "COMPN_CurrentTime": 0.0}

    def Lock(self) -> None:
        self.locked = True

    def Unlock(self) -> None:
        self.locked = False

    def StartUndo(self, name: str) -> None:
        self.undo_log.append(name)

    def EndUndo(self, ok: bool) -> None:
        self.undo_log.append(("end", ok))


class FakeItem:
    """A timeline item whose imports ingest nothing unless told otherwise."""

    def __init__(self, ingest_broken: bool = True) -> None:
        self.names = ["Comp 1"]
        self.comps: dict[str, FakeComp] = {}
        self.imported: list[str] = []
        self.loaded: list[str] = []
        self.deleted: list[str] = []
        self.built: list[FakeComp] = []
        self.ingest_broken = ingest_broken

    def GetFusionCompNameList(self) -> Any:
        return list(self.names)

    def GetCurrentFusionComp(self) -> None:
        return None

    def AddFusionComp(self) -> FakeComp:
        comp = FakeComp()
        self.names.append(f"Comp {len(self.names) + 1}")
        self.comps[self.names[-1]] = comp
        self.built.append(comp)
        return comp

    def ImportFusionComp(self, path: str) -> FakeComp:
        self.imported.append(path)
        self.names.append(f"Comp {len(self.names) + 1}")
        comp = FakeComp()
        if not self.ingest_broken:
            comp.AddTool("Background")
            comp.AddTool("Merge")
            comp.AddTool("Transform")
        self.comps[self.names[-1]] = comp
        return comp

    def LoadFusionCompByName(self, name: str) -> Any:
        self.loaded.append(name)
        return self.comps.get(name, True)

    def DeleteFusionCompByName(self, name: str) -> bool:
        self.deleted.append(name)
        self.names = [known for known in self.names if known != name]
        self.comps.pop(name, None)
        return True
