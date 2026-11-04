#!/usr/bin/env python3
"""Live smoke: import the sample effect spec onto a timeline clip in Resolve.

DO NOT RUN IN CI, and do not run it while Mel is in Resolve. The desk runs
it on the Studio box by hand:

  adapters/resolve/scripts/launch_resolve.sh
  # Open a project timeline; External scripting = Local
  export PYTHONPATH=/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}
  eval "$(mise activate bash)"
  CHAIR_SMOKE_CLIP=/tmp/chair-spike/chair_spike_clip.mov \
    uv run --package chair-adapter-resolve python adapters/resolve/scripts/smoke_fusion.py

What it does: opens (or creates) the "Chair Fusion Smoke" project, puts the
test clip on a new timeline, writes the bounce-title fixture to Chair's comp
cache, and calls TimelineItem.ImportFusionComp on the clip. It prints
GetFusionCompNameList before and after: expect one new comp version, with the
previous version untouched (that is the undo path: LoadFusionCompByName).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT / "adapters" / "resolve" / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "adapters" / "resolve" / "src"))

from chair_resolve import add_effect, remove_effect  # noqa: E402

PROJECT_NAME = "Chair Fusion Smoke"
TIMELINE_NAME = "Chair Fusion Smoke"
CLIP_PATH = os.environ.get("CHAIR_SMOKE_CLIP", "/tmp/chair-spike/chair_spike_clip.mov")
SPEC_PATH = ROOT / "fixtures" / "effects" / "bounce-title.effect.json"


def _fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 2


def main() -> int:
    try:
        import DaVinciResolveScript as bmd
    except ImportError:
        return _fail(
            "DaVinciResolveScript is not importable. "
            "Set PYTHONPATH to Resolve's Developer/Scripting/Modules."
        )
    resolve = bmd.scriptapp("Resolve")
    if resolve is None:
        return _fail("No Resolve scripting host. Launch Resolve Studio first.")
    manager = resolve.GetProjectManager()
    project = manager.GetCurrentProject()
    if project is None or project.GetName() != PROJECT_NAME:
        manager.CreateProject(PROJECT_NAME)
        project = manager.LoadProject(PROJECT_NAME)
    if project is None:
        return _fail(f"Could not open project {PROJECT_NAME!r}.")
    print(f"project={project.GetName()!r}")

    if not Path(CLIP_PATH).is_file():
        return _fail(f"Test clip is missing: {CLIP_PATH}. Set CHAIR_SMOKE_CLIP.")
    pool = project.GetMediaPool()
    imported = pool.ImportMedia([CLIP_PATH])
    if not imported or imported[0] is None:
        return _fail(f"Studio could not import {CLIP_PATH!r}.")

    timeline = pool.CreateEmptyTimeline(TIMELINE_NAME)
    if not timeline:
        return _fail(f"Studio could not create timeline {TIMELINE_NAME!r}.")
    project.SetCurrentTimeline(timeline)
    placed = pool.AppendToTimeline(
        [
            {
                "mediaPoolItem": imported[0],
                "startFrame": 0,
                "endFrame": 89,
                "mediaType": 1,
                "trackIndex": 1,
                "recordFrame": 0,
            }
        ]
    )
    if not placed:
        return _fail("Studio did not place the test clip.")
    item = placed[0]
    print(f"clip={item.GetName()!r}")

    before = list(item.GetFusionCompNameList() or [])
    print(f"comps_before={before}")
    spec = json.loads(SPEC_PATH.read_text())
    op = add_effect(item, spec)
    if "fallback" in op:
        return _fail(f"Fixture fell back: {op['fallback']}")
    after = list(item.GetFusionCompNameList() or [])
    print(f"comps_after={after}")
    print(f"imported_comp={op.get('comp_name')!r} prev_comp={op.get('prev_comp_name')!r}")
    print(f"comp_path={op.get('comp_path')!r}")

    comp = item.GetFusionCompByIndex(item.GetFusionCompCount())
    names = sorted(t.GetAttrs().get("TOOLS_Name", "?") for t in comp.GetToolList().values())
    print(f"tools={names}")
    undone = remove_effect(item, op)
    print(f"undo_back_to_prev={undone}")
    if after == before or len(after) != len(before) + 1:
        return _fail("Expected exactly one new comp version.")
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
