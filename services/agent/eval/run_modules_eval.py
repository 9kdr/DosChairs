"""Eval: run the module briefs through Wonder generate + bundle, record pass/fail.

Usage (repo root; needs META_API_KEY, so run under mise for the .env)::

    mise x -- uv run --package chair-agent \\
        python services/agent/eval/run_modules_eval.py [--brief <id>]

Pass per brief: the module bundles, the probe says deterministic, and at
least one Inspector prop is exposed. Results go to
services/agent/eval/modules_eval_results.json (or --out) and print as a
table. One failing brief never stops the rest.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
import time
from pathlib import Path
from typing import Any

EVAL_DIR = Path(__file__).resolve().parent


def run_one(modules: Any, brief: dict[str, Any], canvas: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    outcome: dict[str, Any] = {
        "id": brief["id"], "kind": brief.get("kind"),
        "ok": False, "repaired": False, "module_id": None,
        "bundled": False, "deterministic": False, "animates": False,
        "props": 0, "inertProps": 0, "slowestFrameMs": None,
        "warnings": [], "errors": [], "seconds": 0.0,
    }
    try:
        record = modules.generate_module(
            brief["brief"], kind=brief.get("kind"),
            width=int(canvas.get("width", 1920)),
            height=int(canvas.get("height", 1080)),
            fps=float(canvas.get("fps", 30)),
            duration_sec=float(canvas.get("durationSec", 8)),
        )
    except Exception as error:
        outcome["errors"].append(f"generate: {error}")
        outcome["seconds"] = round(time.perf_counter() - started, 1)
        return outcome
    outcome["module_id"] = record.id
    outcome["repaired"] = record.repaired
    outcome["warnings"] = list(record.warnings)
    try:
        built = modules.bundle_module(record.id)
    except Exception as error:
        outcome["errors"].append(f"bundle: {error}")
        outcome["seconds"] = round(time.perf_counter() - started, 1)
        return outcome
    checks = built.checks or {}
    outcome["bundled"] = built.stem is not None
    outcome["deterministic"] = checks.get("deterministic") is True
    outcome["animates"] = checks.get("animates") is True
    outcome["props"] = len(built.props)
    outcome["inertProps"] = checks.get("inertProps", 0)
    outcome["slowestFrameMs"] = checks.get("slowestFrameMs")
    outcome["preview"] = f"/effects/modules/{record.id}/preview"
    outcome["ok"] = (
        outcome["bundled"] and outcome["deterministic"] and outcome["props"] > 0
    )
    outcome["seconds"] = round(time.perf_counter() - started, 1)
    return outcome


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brief", default=None, help="run only this brief id")
    parser.add_argument("--out", default=None, help="results JSON path")
    args = parser.parse_args(argv)

    from chair_agent import modules

    data = json.loads((EVAL_DIR / "modules_briefs.json").read_text(encoding="utf-8"))
    canvas = data.get("canvas", {})
    briefs = [b for b in data["briefs"] if args.brief is None or b["id"] == args.brief]
    if args.brief is not None and not briefs:
        print(f"unknown brief: {args.brief}", file=sys.stderr)
        return 2
    results: dict[str, Any] = {
        "model": modules.module_model(),
        "started": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "briefs": {},
    }
    for brief in briefs:
        outcome = run_one(modules, brief, canvas)
        results["briefs"][outcome["id"]] = outcome
        mark = "PASS" if outcome["ok"] else "FAIL"
        detail = (
            f"props={outcome['props']} det={outcome['deterministic']} "
            f"repaired={outcome['repaired']} {outcome['seconds']}s"
        )
        errors = f" :: {'; '.join(outcome['errors'][:2])}" if outcome["errors"] else ""
        print(f"[{mark}] {outcome['id']} {detail}{errors}", flush=True)
    out = Path(args.out) if args.out else EVAL_DIR / "modules_eval_results.json"
    out.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    passed = sum(1 for b in results["briefs"].values() if b["ok"])
    print(f"{passed}/{len(results['briefs'])} passed -> {out}")
    return 0 if passed == len(results["briefs"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
