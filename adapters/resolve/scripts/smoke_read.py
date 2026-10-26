#!/usr/bin/env python3
"""Live smoke: read the open Resolve timeline into Chair IR.

Agents: Studio must already be running with a project timeline open.
External scripting must be Local or Network (Preferences > System > General).

  /opt/resolve/bin/resolve &
  # wait until scriptapp connects, open a project + timeline in the UI if needed
  export PYTHONPATH=/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}
  cd "$(git rev-parse --show-toplevel)"
  eval "$(mise activate bash)"
  uv run --package chair-adapter-resolve python adapters/resolve/scripts/smoke_read.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT / "adapters" / "resolve" / "src") not in sys.path:
    # uv run --package sets this; keep a plain-python fallback for ResolvePython
    sys.path.insert(0, str(ROOT / "adapters" / "resolve" / "src"))

from chair_resolve import ResolveClosedError, read_current_timeline  # noqa: E402


def main() -> int:
    try:
        timeline = read_current_timeline()
    except ResolveClosedError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    tracks = [(t["id"], t["kind"], t["name"], len(t["clips"])) for t in timeline["tracks"]]
    print("OK")
    print(f"name={timeline['name']!r} id={timeline['id']!r} rate={timeline['rate']}")
    print(f"tracks={tracks}")
    print(f"markers={len(timeline.get('markers', []))}")
    out = ROOT / "data" / "proxies" / "resolve-smoke-timeline.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(timeline, indent=2)[:80_000])
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
