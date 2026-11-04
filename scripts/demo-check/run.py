#!/usr/bin/env python3
"""Demo check: prove the three filmed flows still work, after every merge.

Runs the effect, rig, and sound prompts from prompts.json against a live
agent plus Resolve (throwaway project "Chair Captest" only), or against
fakes with --dry-run. Prints a short table, writes a JSON report to
/tmp/demo-check/<timestamp>.json, and exits non-zero when any flow fails.

Usage:
  uv run python scripts/demo-check/run.py --agent http://127.0.0.1:8807
  uv run python scripts/demo-check/run.py --dry-run [--only effect|rig|sound]

Safety: never opens Chair Spike or any other project except restoring the
startup project at the end; deletes only timelines and comp versions this
run created; refuses to start while /tmp/chair-resolve.lock is held.
Reads go through GetFusionCompByName and never load a comp; undo drives
the real POST /effects/rig/revert route (crash-guarded, #290), and the
version list must match the before-state afterwards.
"""

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import time
import zlib
import urllib.error
import urllib.request
from datetime import UTC, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPTS_PATH = os.path.join(HERE, "prompts.json")
SIM_ENTRY = os.path.join(HERE, "sim-rig.ts")
BAKE_LOADER = os.path.join(HERE, "ts-register.mjs")

PROJECT = "Chair Captest"
TIMELINE = "demo-check"
DIALOGUE = "dialogue.mp4"
MUSIC = "music.wav"
LOCK_PATH = "/tmp/chair-resolve.lock"
REPORT_DIR = "/tmp/demo-check"

# The cursor piece is a short move, not the whole 40-second clip: the model
# writes it, the agent bakes it, and Resolve plays it through a Loader.
RIG_DURATION_SEC = 4.0
RIG_LAYER_ID = "cursor"

# Mirrors scripting_module_paths in adapters/resolve/src/chair_resolve/read.py.
SCRIPTING_PATHS = [
    "/opt/resolve/Developer/Scripting/Modules",
    "/Library/Application Support/Blackmagic Design/"
    "DaVinci Resolve/Developer/Scripting/Modules",
]

TOKENS_NOTE = (
    "not exposed by the agent: Completion carries model+text only "
    "(services/agent/src/chair_agent/client.py). Suggest recording usage "
    "there and surfacing it via the effects/modules status snapshots and /health."
)


class Fail(Exception):
    """One flow step failed; the message is the plain one-line reason."""


def post_json(base: str, path: str, body: dict, timeout: int = 600) -> dict:
    """POST JSON to the agent. Raises Fail with the agent's plain message."""
    url = base + path
    request = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Fail(_agent_message(error, path)) from error
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise Fail(f"agent is unreachable at {url} ({error})") from error


def get_json(base: str, path: str, timeout: int = 60) -> dict:
    """GET JSON from the agent. Raises Fail with the agent's plain message."""
    url = base + path
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Fail(_agent_message(error, path)) from error
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise Fail(f"agent is unreachable at {url} ({error})") from error


def _agent_message(error: urllib.error.HTTPError, path: str) -> str:
    try:
        payload = json.load(error)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("error")
        if isinstance(detail, str) and detail:
            return f"{path}: {detail}"
        if isinstance(detail, dict) and detail.get("message"):
            return f"{path}: {detail['message']}"
    return f"{path}: agent failed (HTTP {error.code})"


class Lock:
    """Refuse to start while another Resolve user holds the lock file."""

    def __init__(self) -> None:
        self.held = False

    def acquire(self) -> None:
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise Fail(f"Resolve is busy: {LOCK_PATH} is held") from None
        with os.fdopen(fd, "w") as handle:
            handle.write(str(os.getpid()))
        self.held = True

    def release(self) -> None:
        if self.held:
            try:
                os.unlink(LOCK_PATH)
            except OSError:
                pass
            self.held = False


def new_flow(name: str, prompt: str) -> dict:
    return {
        "name": name, "prompt": prompt, "status": "FAIL", "reason": "not run",
        "seconds": {}, "repairs": 0, "model_calls": "unknown",
        "tokens_cost": TOKENS_NOTE, "evidence": {}, "notes": [],
    }


def timed(seconds: dict, name: str, func, *args):
    start = time.perf_counter()
    try:
        return func(*args)
    finally:
        seconds[name] = round(seconds.get(name, 0.0) + time.perf_counter() - start, 1)


def all_pass(report: dict) -> bool:
    return bool(report["flows"]) and all(
        flow["status"] == "PASS" for flow in report["flows"]
    )


def format_table(report: dict) -> str:
    lines = [
        f"demo check {report['timestamp']} {report['mode']}"
        f" agent={report['agent']}",
        "flow    result  steps                          reason",
    ]
    for flow in report["flows"]:
        steps = " ".join(
            f"{name[0]}={flow['seconds'].get(name, 0):.1f}s"
            for name in ("generate", "bake", "apply", "undo")
            if name in flow["seconds"]
        )
        lines.append(
            f"{flow['name']:<7} {flow['status']:<6} {steps:<30} {flow['reason']}"
        )
    passed = sum(flow["status"] == "PASS" for flow in report["flows"])
    lines.append(f"{passed}/{len(report['flows'])} flows passed")
    lines.append(f"report: {report['path']}")
    return "\n".join(lines)


def report_path(now: datetime) -> str:
    return os.path.join(REPORT_DIR, now.strftime("%Y%m%dT%H%M%S") + ".json")


def write_report(report: dict) -> str:
    os.makedirs(REPORT_DIR, exist_ok=True)
    path = report_path(datetime.now(UTC))
    report["path"] = path
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    return path


def health_snapshot(world) -> dict:
    """The /health counters one flow's model use is read from."""
    health = world.get("/health")
    effects = health.get("effects", {})
    modules = health.get("modules", {})
    return {
        "effects_generated": effects.get("generated", 0),
        "effects_repairs": effects.get("repairs", 0),
        "effects_latency_ms": effects.get("last_latency_ms"),
        "modules_generated": modules.get("generated", 0),
        "modules_repairs": modules.get("repaired", 0),
        "modules_latency_ms": modules.get("last_generate_ms"),
    }


def health_delta(before: dict, after: dict, *areas: str) -> tuple[int, int]:
    """(model calls, repairs) across the named areas since the snapshot."""
    calls = sum(
        after[f"{area}_generated"] - before[f"{area}_generated"]
        + after[f"{area}_repairs"] - before[f"{area}_repairs"]
        for area in areas
    )
    repairs = sum(
        after[f"{area}_repairs"] - before[f"{area}_repairs"] for area in areas
    )
    return calls, repairs


def check_undo(names: list, made: str, prev: str | None, before: list,
             tools_now: int | None = None,
             tools_before: int | None = None) -> str:
    """Prove an undo. Returns 'switch', 'remove', or 'unwind'.

    Switch keeps the added version (redo stays possible), so prev must
    stand beside it; remove must restore the before-state exactly. When
    the added version stands alone, only a strict tool-count drop proves
    the build was unwound inside it (#295).
    """
    if made not in names:
        if sorted(names) != sorted(before):
            raise Fail(f"undo left versions {names}, expected {before}")
        return "remove"
    if prev in names:
        return "switch"
    if (tools_before is not None and tools_now is not None
            and tools_now < tools_before):
        return "unwind"
    raise Fail(f"undo left {made!r} standing with its build")


class Live:
    """The real agent plus the real Resolve. Every method may raise Fail."""

    def __init__(self, agent: str) -> None:
        self.agent = agent
        self.resolve = None
        self.projects = None
        self.project = None
        self.start_project = ""
        self.clip_names: dict = {}

    def post(self, path: str, body: dict, timeout: int = 600) -> dict:
        return post_json(self.agent, path, body, timeout)

    def get(self, path: str, timeout: int = 60) -> dict:
        return get_json(self.agent, path, timeout)

    def sim(self, values: dict) -> dict:
        """Run the kit follower sim over the demo path (node, no build step)."""
        errors = os.path.join(REPORT_DIR, "sim.err")
        os.makedirs(REPORT_DIR, exist_ok=True)
        values_path = os.path.join(REPORT_DIR, "sim-values.json")
        with open(values_path, "w", encoding="utf-8") as handle:
            json.dump(values, handle)
        try:
            done = subprocess.run(
                ["node", "--import", BAKE_LOADER, SIM_ENTRY, values_path],
                capture_output=True, text=True, timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Fail(f"sim: node could not run the kit sim ({error})") from error
        if done.returncode != 0:
            with open(errors, "w", encoding="utf-8") as handle:
                handle.write(done.stderr)
            raise Fail(f"sim: the kit sim failed (see {errors})")
        try:
            return json.loads(done.stdout)
        except ValueError as error:
            raise Fail(f"sim: the kit sim printed no JSON ({error})") from error

    def setup(self) -> dict:
        """Open Chair Captest, build the throwaway timeline, read its shape."""
        try:
            import DaVinciResolveScript as bmd
        except ImportError:
            for path in SCRIPTING_PATHS:
                if os.path.isdir(path) and path not in sys.path:
                    sys.path.insert(0, path)
            try:
                import DaVinciResolveScript as bmd
            except ImportError as error:
                raise Fail(f"Resolve Studio is not reachable ({error})") from error
        self.resolve = bmd.scriptapp("Resolve")
        self.projects = self.resolve.GetProjectManager()
        current = self.projects.GetCurrentProject()
        self.start_project = current.GetName() if current is not None else ""
        if not self.projects.LoadProject(PROJECT):
            raise Fail(f"Resolve would not open {PROJECT!r}")
        self.project = self.projects.GetCurrentProject()
        if self.project is None or self.project.GetName() != PROJECT:
            raise Fail(f"{PROJECT!r} is not open in Resolve")
        media_pool = self.project.GetMediaPool()
        clips = {
            clip.GetName(): clip
            for clip in (media_pool.GetRootFolder().GetClipList() or [])
        }
        for name in (DIALOGUE, MUSIC):
            if name not in clips:
                raise Fail(f"{PROJECT!r} has no {name}; import it first")
        stale = self._find_timeline(TIMELINE)
        if stale is not None:
            media_pool.DeleteTimelines([stale])
        timeline = media_pool.CreateTimelineFromClips(
            TIMELINE, [clips[DIALOGUE], clips[MUSIC]])
        if timeline is None:
            raise Fail(f"Resolve would not make the {TIMELINE!r} timeline")
        self.project.SetCurrentTimeline(timeline)
        width = int(timeline.GetSetting("timelineResolutionWidth") or 1920)
        height = int(timeline.GetSetting("timelineResolutionHeight") or 1080)
        fps = float(timeline.GetSetting("timelineFrameRate") or 24)
        total_frames = int(timeline.GetEndFrame() - timeline.GetStartFrame())
        music_items = timeline.GetItemListInTrack("audio", 1) or []
        music_id = music_items[-1].GetUniqueId() if music_items else ""
        return {
            "width": width, "height": height, "fps": fps,
            "duration_sec": round(total_frames / fps, 3) if fps else 0,
            "total_frames": total_frames, "rate": fps,
            "proxy_url": clips[DIALOGUE].GetClipProperty("File Path"),
            "music_clip_id": music_id or "a1-2",
        }

    def locator(self) -> dict:
        return {
            "trackIndex": 1, "clipIndex": 0, "trackType": "video",
            "project": PROJECT, "timeline": TIMELINE,
        }

    def comp_state(self) -> dict:
        """Comp versions and tool counts on the demo clip.

        Reads through GetFusionCompByName and never loads a comp:
        LoadFusionCompByName segfaulted Studio 21.1 (Fusion UI setup raced
        the scripted load). There is no GetCurrentFusionComp on TimelineItem.
        """
        item = self._demo_item()
        names = list(item.GetFusionCompNameList() or [])
        get_comp = getattr(item, "GetFusionCompByName", None)
        tools = {}
        for name in names:
            comp = get_comp(name) if callable(get_comp) else None
            tools[name] = len(comp.GetToolList(False) or {}) if comp else 0
        return {"names": names, "tools": tools}

    def undo_comp(self, op: dict, before: list, tools_before: int) -> tuple[str, str]:
        """Undo the apply through the real route, then prove the versions.

        POST /effects/rig/revert is the product undo (crash-guarded, #290):
        it switches back when the Fusion UI is up (the added version stays
        for redo), removes the added version, or unwinds the build inside
        it (#295). Returns (prev, undone_by).
        """
        prev = (op.get("undo") or {}).get("prev_comp_name",
                                          op.get("prev_comp_name"))
        self.post("/effects/rig/revert", {"op": op, **self.locator()})
        state = self.comp_state()
        undone_by = check_undo(
            state["names"], op.get("comp_name", ""),
            prev if isinstance(prev, str) else None, before,
            state["tools"].get(op.get("comp_name", ""), 0), tools_before)
        return (prev if isinstance(prev, str) else "", undone_by)

    def delete_comp(self, name: str) -> None:
        item = self._demo_item()
        if name in (item.GetFusionCompNameList() or []):
            item.DeleteFusionCompByName(name)

    def keyframe_readback(self, comp_name: str) -> dict | None:
        """Best-effort spline key counts off the new comp (None when unreadable)."""
        try:
            item = self._demo_item()
            get_comp = getattr(item, "GetFusionCompByName", None)
            comp = get_comp(comp_name) if callable(get_comp) else None
            tools = comp.GetToolList(False) or {} if comp is not None else {}
        except Exception:
            return None
        counts = {}
        try:
            for tool in tools.values():
                get_frames = getattr(tool, "GetKeyFrames", None)
                if not callable(get_frames):
                    continue
                frames = get_frames()
                size = len(frames) if isinstance(frames, (dict, list)) else 0
                if size:
                    attrs = tool.GetAttrs() or {}
                    counts[str(attrs.get("TOOLS_Name", "?"))] = size
        except Exception:
            return None
        return counts or None

    def snapshot(self, name: str) -> dict:
        """Track and clip counts on one timeline (sound copy evidence)."""
        timeline = self._find_timeline(name)
        if timeline is None:
            raise Fail(f"timeline {name!r} is not in {PROJECT!r}")
        per_track: dict[str, int] = {}
        for track_type in ("video", "audio"):
            count = int(timeline.GetTrackCount(track_type) or 0)
            for index in range(1, count + 1):
                items = timeline.GetItemListInTrack(track_type, index) or []
                per_track[f"{track_type}{index}"] = len(items)
        return {
            "video_tracks": int(timeline.GetTrackCount("video") or 0),
            "audio_tracks": int(timeline.GetTrackCount("audio") or 0),
            "clips": sum(per_track.values()),
            "per_track": per_track,
        }

    def current_timeline(self) -> str:
        current = self.project.GetCurrentTimeline()
        return current.GetName() if current is not None else ""

    def cleanup(self, created: dict) -> None:
        """Delete only what this run made, then restore the startup project."""
        try:
            if self.project is not None and self.project.GetName() == PROJECT:
                for name in created.get("comps", []):
                    try:
                        self.delete_comp(name)
                    except Exception:
                        pass
                media_pool = self.project.GetMediaPool()
                for name in [TIMELINE, *created.get("timelines", [])]:
                    timeline = self._find_timeline(name)
                    if timeline is not None:
                        try:
                            media_pool.DeleteTimelines([timeline])
                        except Exception:
                            pass
        finally:
            if self.start_project and self.start_project != PROJECT:
                self.projects.LoadProject(self.start_project)
                current = self.projects.GetCurrentProject()
                name = current.GetName() if current is not None else ""
                if name != self.start_project:
                    raise Fail(
                        f"could not restore {self.start_project!r}; "
                        f"Resolve is on {name or PROJECT!r}")

    def _find_timeline(self, name: str):
        count = self.project.GetTimelineCount() or 0
        for index in range(1, count + 1):
            candidate = self.project.GetTimelineByIndex(index)
            if candidate is not None and candidate.GetName() == name:
                return candidate
        return None

    def _demo_item(self):
        timeline = self._find_timeline(TIMELINE)
        if timeline is None:
            raise Fail(f"timeline {TIMELINE!r} is gone from {PROJECT!r}")
        items = timeline.GetItemListInTrack("video", 1) or []
        if not items:
            raise Fail(f"timeline {TIMELINE!r} has no clip on video track 1")
        return items[0]

class Dry:
    """Canned agent plus in-memory Resolve for --dry-run (CI, no Resolve)."""

    def __init__(self, agent: str) -> None:
        self.agent = agent
        # Live clips list a phantom first version; mirror it.
        self.comps: list = ["dry-comp-0"]
        self.tools: dict = {"dry-comp-0": 2}
        self.applied = 0
        self.reverts = 0
        self.timelines = {
            TIMELINE: {"video_tracks": 1, "audio_tracks": 1, "clips": 2,
                       "per_track": {"video1": 1, "audio1": 1}},
        }
        self.current_timeline_name = TIMELINE

    def post(self, path: str, body: dict, timeout: int = 600) -> dict:
        if path == "/effects/generate":
            return {"id": "fx-dry-1",
                    "spec": {"id": "fx-dry-1", "layers": []},
                    "notes": "dry run"}
        if path == "/effects/modules/generate":
            return {
                "id": "fxm-dry-1",
                "meta": {"id": "dry-rig", "name": "Dry Rig", "kind": "rig",
                         "durationSec": RIG_DURATION_SEC, "fps": 24,
                         "width": 1920, "height": 1080},
                "props": ["targetX", "targetY", "stiffness", "damping",
                          "mass", "swing", "squash", "overshoot"],
                "checks": {"deterministic": True, "animates": True,
                           "slowestFrameMs": 3.2, "inertProps": 0},
                "warnings": [], "stem": None, "files": [],
                "keyframes": None,
                "notes": "Written by dry-model from the brief.",
                "repaired": False,
                "preview": "/effects/modules/fxm-dry-1/preview",
                "plan": {"parts": [{"route": "new"}],
                         "counts": {"native": 0, "reuse": 0, "new": 1}},
            }
        if (path.startswith("/effects/modules/")
                and path.endswith("/bundle")):
            made = self.post("/effects/modules/generate", {})
            made["props"] = [
                {"id": "targetX", "label": "Target X", "type": "number",
                 "default": 960, "min": 0, "max": 1920},
                {"id": "targetY", "label": "Target Y", "type": "number",
                 "default": 540, "min": 0, "max": 1080},
                {"id": "stiffness", "label": "Stiffness", "type": "number",
                 "default": 150, "min": 20, "max": 400},
                {"id": "damping", "label": "Damping", "type": "number",
                 "default": 11, "min": 3, "max": 40},
                {"id": "mass", "label": "Mass", "type": "number",
                 "default": 1, "min": 0.2, "max": 5},
                {"id": "swing", "label": "Swing", "type": "number",
                 "default": 1, "min": 0, "max": 2},
                {"id": "squash", "label": "Squash", "type": "number",
                 "default": 1, "min": 0, "max": 2},
                {"id": "overshoot", "label": "Overshoot", "type": "bool",
                 "default": True},
            ]
            made["stem"] = "chair-dry-rig"
            made["files"] = ["chair-dry-rig.ograf.json", "chair-dry-rig.js"]
            return made
        if path == "/effects/rig/apply":
            self.applied += 1
            prev = self.comps[-1] if self.comps else None
            name = f"dry-comp-{self.applied}"
            self.comps.append(name)
            self.tools[name] = 6
            return {"effect_id": "fx-dry-1", "comp_name": name,
                    "prev_comp_name": prev, "keyframes": 12,
                    "project": PROJECT, "timeline": TIMELINE,
                    "undo": {"prev_comp_name": prev}}
        if path == "/effects/rig/revert":
            op = body.get("op", {})
            made = op.get("comp_name", "")
            prev = (op.get("undo") or {}).get("prev_comp_name",
                                              op.get("prev_comp_name"))
            self.reverts += 1
            if self.reverts % 2 == 0 and made in self.comps:
                # Every other undo takes the remove path, so dry-run
                # covers both undo proofs; the live clip takes switch.
                self.comps.remove(made)
                self.tools.pop(made, None)
            return {"comp_name": prev, "project": PROJECT, "timeline": TIMELINE}
        if path == "/jobs":
            return {"request_id": "dry-job-1", "status": "queued"}
        if path == "/sounds/apply":
            copy = f"{TIMELINE} (sound copy)"
            self.timelines[copy] = {
                "video_tracks": 1, "audio_tracks": 2, "clips": 4,
                "per_track": {"video1": 1, "audio1": 1, "audio2": 2}}
            self.current_timeline_name = copy
            return {"timeline_name": copy, "original_timeline": TIMELINE,
                    "tracks_added": 1, "clips_added": 2,
                    "skipped": [], "fallback": None}
        if path == "/sounds/undo":
            copy = body.get("timeline_name", "")
            self.timelines.pop(copy, None)
            self.current_timeline_name = TIMELINE
            return {"current_timeline": TIMELINE, "deleted": True}
        raise Fail(f"dry run has no canned {path}")

    def get(self, path: str, timeout: int = 60) -> dict:
        if path == "/health":
            return {"effects": {"generated": 0, "repairs": 0,
                                "last_latency_ms": None},
                    "modules": {"generated": 0, "repaired": 0,
                                "last_generate_ms": None}}
        if path == "/jobs/dry-job-1":
            return {"request_id": "dry-job-1", "status": "completed",
                    "planner": "rules", "message": None, "skipped": [],
                    "changeset": {"ops": [
                        {"op": "add_track", "id": "track-sfx-1"},
                        {"op": "add_clip", "id": "sfx-riser-1"},
                        {"op": "add_clip", "id": "sfx-tapestop-1"},
                        {"op": "set_gain", "id": "duck-1"}]}}
        raise Fail(f"dry run has no canned {path}")

    def sim(self, values: dict) -> dict:
        samples = values.get("samples", 48)
        poses = []
        for index in range(samples):
            mix = index / max(samples - 1, 1)
            over = 14.0 if 0.3 < mix < 0.36 else 0.0
            poses.append({
                "t": round(mix * RIG_DURATION_SEC, 3),
                "x": 120.0 + 840.0 * (1.0 - (1.0 - mix) ** 2) + over,
                "y": 540.0, "tilt": 0.0})
        return {"poses": poses}

    def setup(self) -> dict:
        return {"width": 1920, "height": 1080, "fps": 24.0,
                "duration_sec": 20.0, "total_frames": 480, "rate": 24.0,
                "proxy_url": "/tmp/dry-dialogue.mp4",
                "music_clip_id": "dry-music-1"}

    def locator(self) -> dict:
        return {"trackIndex": 1, "clipIndex": 0, "trackType": "video",
                "project": PROJECT, "timeline": TIMELINE}

    def comp_state(self) -> dict:
        return {"names": list(self.comps), "tools": dict(self.tools)}

    def undo_comp(self, op: dict, before: list, tools_before: int) -> tuple[str, str]:
        prev = (op.get("undo") or {}).get("prev_comp_name",
                                          op.get("prev_comp_name"))
        self.post("/effects/rig/revert", {"op": op, **self.locator()})
        undone_by = check_undo(
            list(self.comps), op.get("comp_name", ""),
            prev if isinstance(prev, str) else None, before,
            self.tools.get(op.get("comp_name", ""), 0), tools_before)
        return (prev if isinstance(prev, str) else "", undone_by)

    def delete_comp(self, name: str) -> None:
        if name in self.comps:
            self.comps.remove(name)
            self.tools.pop(name, None)

    def keyframe_readback(self, comp_name: str) -> dict | None:
        return {"drySpline": 12}

    def snapshot(self, name: str) -> dict:
        if name not in self.timelines:
            raise Fail(f"timeline {name!r} is not in {PROJECT!r}")
        return dict(self.timelines[name])

    def current_timeline(self) -> str:
        return self.current_timeline_name

    def cleanup(self, created: dict) -> None:
        return None


def flow_effect(world, prompts: dict, info: dict, created: dict) -> dict:
    """Generate the dither fade, apply it, undo to the previous comp."""
    flow = new_flow("effect", prompts["effect"])
    before_health = None
    try:
        before_health = health_snapshot(world)
        canvas = {"width": info["width"], "height": info["height"]}
        generated = timed(
            flow["seconds"], "generate", world.post, "/effects/generate",
            {"prompt": flow["prompt"], "canvas": canvas,
             "fps": info["fps"], "durationSec": info["duration_sec"]})
        effect_id = generated.get("id", "")
        flow["evidence"]["effect_id"] = effect_id
        flow["evidence"]["notes"] = generated.get("notes", "")
        if not effect_id or not isinstance(generated.get("spec"), dict):
            raise Fail("generate answered without an effect id and spec")
        state_before = world.comp_state()
        flow["evidence"]["versions_before"] = state_before["names"]
        applied = timed(
            flow["seconds"], "apply", world.post, "/effects/rig/apply",
            {"effectId": effect_id, **world.locator()})
        if "fallback" in applied:
            reason = applied["fallback"].get("reason", "no reason given")
            raise Fail(f"Resolve could not take this piece: {reason}")
        comp = applied.get("comp_name")
        prev = applied.get("prev_comp_name")
        flow["evidence"]["comp_name"] = comp
        flow["evidence"]["prev_comp_name"] = prev
        state_after = world.comp_state()
        if not comp or comp in state_before["names"]:
            raise Fail("apply did not land as a new comp version")
        created["comps"].append(comp)
        new_tools = state_after["tools"].get(comp, 0)
        flow["evidence"]["new_comp_tools"] = new_tools
        if new_tools == 0:
            raise Fail(f"new comp {comp!r} is empty or unreadable")
        prev_tools_before = state_before["tools"].get(prev or "", None)
        prev_tools_after = state_after["tools"].get(prev or "", None)
        flow["evidence"]["prev_comp_tools_before"] = prev_tools_before
        flow["evidence"]["prev_comp_tools_after"] = prev_tools_after
        if prev is not None and prev_tools_before != prev_tools_after:
            raise Fail(f"apply touched the previous comp {prev!r}")
        flow["evidence"]["spline_readback"] = world.keyframe_readback(comp)
        op = {"comp_name": comp, "prev_comp_name": prev,
              "undo": {"prev_comp_name": prev}}
        _, undone_by = timed(flow["seconds"], "undo", world.undo_comp, op,
                             state_before["names"], new_tools)
        flow["evidence"]["undone_by"] = undone_by
        flow["status"] = "PASS"
        if undone_by == "unwind":
            undone = f"build unwound inside {comp}"
        else:
            undone = f"undone to {prev}" if prev else "only version removed"
        flow["reason"] = f"new comp {comp} with {new_tools} tools, {undone}"
    except Fail as error:
        flow["reason"] = str(error)
    finally:
        if before_health is not None:
            try:
                after_health = health_snapshot(world)
            except Fail:
                after_health = None
            if after_health is not None:
                calls, repairs = health_delta(before_health, after_health,
                                              "effects")
                flow["repairs"] = repairs
                flow["model_calls"] = calls
                flow["evidence"]["latency_ms"] = after_health.get(
                    "effects_latency_ms")
    return flow


def prop_ids(props) -> list:
    """Prop ids from a module summary: bare ids, or full bundled specs."""
    out = []
    for entry in props or []:
        if isinstance(entry, str):
            out.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("id"), str):
            out.append(entry["id"])
    return out


def match_control(ids: list, *parts: str):
    """First prop id containing every part (case-insensitive)."""
    for entry in ids:
        low = entry.lower()
        if all(part in low for part in parts):
            return entry
    return None


def target_axis(ids: list, axis: str):
    """The target position control for one axis (targetX, targetY)."""
    for entry in ids:
        low = entry.lower()
        if "target" in low and low.endswith(axis):
            return entry
    return None


def rig_target_path(tx: float, ty: float) -> list:
    """The demo's swing-in path: in from the left, settle, bounce on click."""
    return [
        {"time": 0.0, "x": 120.0, "y": ty},
        {"time": 1.2, "x": tx, "y": ty},
        {"time": 2.0, "x": tx, "y": ty},
        {"time": 2.5, "x": tx, "y": ty + 40.0},
        {"time": 2.7, "x": tx, "y": ty},
        {"time": 2.9, "x": tx, "y": ty + 18.0},
        {"time": 3.2, "x": tx, "y": ty},
        {"time": RIG_DURATION_SEC, "x": tx, "y": ty},
    ]


def feel_numbers(poses: list, tx: float, ty: float) -> dict:
    """How much the follower moves after arrival, and its peak speed."""
    settled = [pose for pose in poses if pose.get("t", 0) >= 1.2]
    dev = 0.0
    for pose in settled:
        dev = max(dev, math.hypot(pose["x"] - tx, pose["y"] - ty))
    peak = 0.0
    for first, second in zip(poses, poses[1:]):
        span = second["t"] - first["t"]
        if span > 0:
            peak = max(peak, math.hypot(second["x"] - first["x"],
                                        second["y"] - first["y"]) / span)
    return {"settle_dev_px": round(dev, 1),
            "peak_speed_px_s": round(peak)}


def write_strip_png(poses: list, path: str, cells: int = 12) -> str:
    """Frame strip of the follower (stdlib PNG): fading trail, orange dot."""
    cell_w, cell_h, gap = 160, 90, 6
    width = cells * cell_w + (cells - 1) * gap
    rows = [bytearray([20, 20, 20]) * width for _ in range(cell_h)]

    def dot(cx: int, cy: int, radius: int, color: tuple) -> None:
        for dy in range(-radius, radius + 1):
            y = cy + dy
            if y < 0 or y >= cell_h:
                continue
            dx = int((radius * radius - dy * dy) ** 0.5)
            for x in range(cx - dx, cx + dx + 1):
                if 0 <= x < width:
                    rows[y][x * 3:x * 3 + 3] = bytes(color)

    for cell in range(cells):
        pick = round(cell * (len(poses) - 1) / max(cells - 1, 1))
        base = cell * (cell_w + gap)
        stride = max(pick // 16, 1)
        for back in range(0, pick + 1, stride):
            pose = poses[back]
            fade = back / max(pick, 1)
            gray = round(40 + 90 * fade)
            dot(base + round(pose["x"] * cell_w / 1920),
                round(pose["y"] * cell_h / 1080), 2, (gray, gray, gray))
        pose = poses[pick]
        dot(base + round(pose["x"] * cell_w / 1920),
            round(pose["y"] * cell_h / 1080), 5, (255, 106, 0))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, cell_h,
                                       8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(png)
    return path


def flow_rig(world, prompts: dict, info: dict, created: dict) -> dict:
    """Generate the cursor piece live, check it, bundle it, apply it, undo."""
    flow = new_flow("rig", prompts["rig"])
    flow["notes"].append(
        "the swing-in target path is the demo input; the spring values "
        "are the model's.")
    before_health = None
    try:
        before_health = health_snapshot(world)
        canvas = {"width": info["width"], "height": info["height"]}
        made = timed(
            flow["seconds"], "generate", world.post,
            "/effects/modules/generate",
            {"brief": flow["prompt"], "kind": "rig", "canvas": canvas,
             "fps": info["fps"], "durationSec": RIG_DURATION_SEC})
        module_id = made.get("id", "")
        flow["evidence"]["module_id"] = module_id
        notes = made.get("notes", "")
        flow["evidence"]["notes"] = notes
        flow["evidence"]["repaired"] = made.get("repaired", False)
        if not module_id:
            raise Fail("the piece planner left nothing to make: " + notes)
        if "Written by" not in notes or "deterministic fallback" in notes:
            raise Fail("the piece was not written live by the model")
        meta = made.get("meta") or {}
        flow["evidence"]["meta_kind"] = meta.get("kind")
        if meta.get("kind") != "rig":
            raise Fail(f"the piece is kind {meta.get('kind')!r}, not a rig")
        checks = made.get("checks") or {}
        flow["evidence"]["checks"] = checks
        if checks.get("deterministic") is False:
            raise Fail("the piece failed the determinism check")
        ids = prop_ids(made.get("props"))
        flow["evidence"]["prop_ids"] = ids
        controls = {
            "x": target_axis(ids, "x"),
            "y": target_axis(ids, "y"),
            "stiffness": match_control(ids, "stiff"),
            "mass": match_control(ids, "mass"),
            "swing": match_control(ids, "swing"),
        }
        missing = sorted(name for name, hit in controls.items()
                         if hit is None)
        if missing:
            raise Fail("the piece exposes no keyframable "
                       + ", ".join(missing))
        flow["evidence"]["controls"] = controls
        bundled = timed(flow["seconds"], "bake", world.post,
                        f"/effects/modules/{module_id}/bundle", {})
        specs = {entry["id"]: entry for entry in bundled.get("props", [])
                 if isinstance(entry, dict)
                 and isinstance(entry.get("id"), str)}
        for name in controls.values():
            if specs.get(name, {}).get("type") != "number":
                raise Fail(f"control {name!r} is not a keyframable number")
        values = {}
        for name in controls.values():
            default = specs[name].get("default")
            if isinstance(default, bool) \
                    or not isinstance(default, (int, float)):
                raise Fail(f"control {name!r} has no numeric default")
            values[name] = float(default)
        flow["evidence"]["values"] = values
        flow["evidence"]["stem"] = bundled.get("stem")

        def opt_num(prop_id, fallback: float) -> float:
            if prop_id is None:
                return fallback
            default = specs.get(prop_id, {}).get("default")
            if isinstance(default, bool) \
                    or not isinstance(default, (int, float)):
                return fallback
            return float(default)

        damping_id = match_control(ids, "damp")
        squash_id = match_control(ids, "squash")
        overshoot_id = match_control(ids, "overshoot")
        damping = opt_num(damping_id, 11.0)
        squash = opt_num(squash_id, 1.0)
        overshoot = specs.get(overshoot_id, {}).get("default", True)
        if overshoot is not True and overshoot is not False:
            overshoot = True
        tx, ty = values[controls["x"]], values[controls["y"]]
        path = rig_target_path(tx, ty)
        simmed = timed(flow["seconds"], "bake", world.sim, {
            "xName": controls["x"], "yName": controls["y"], "path": path,
            "stiffness": values[controls["stiffness"]], "damping": damping,
            "mass": values[controls["mass"]],
            "swing": values[controls["swing"]], "squash": squash,
            "overshoot": overshoot, "durationSec": RIG_DURATION_SEC,
            "samples": 48})
        poses = simmed.get("poses", [])
        if not poses:
            raise Fail("the kit sim returned no poses")
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        strip = write_strip_png(
            poses, os.path.join(REPORT_DIR, "rig", f"strip-{stamp}.png"))
        flow["evidence"]["strip"] = strip
        flow["evidence"]["feel"] = feel_numbers(poses, tx, ty)

        def keys(axis: str) -> list:
            return [{"time": key["time"], "value": key[axis]}
                    for key in path]

        params = {"module": module_id}
        for role in ("stiffness", "mass", "swing"):
            params[controls[role]] = values[controls[role]]
        if damping_id is not None:
            params[damping_id] = damping
        if squash_id is not None:
            params[squash_id] = squash
        if overshoot_id is not None:
            params[overshoot_id] = overshoot
        spec = {
            "schemaVersion": "0.1.0", "id": module_id,
            "name": f"Rig {module_id}",
            "width": info["width"], "height": info["height"],
            "fps": info["fps"], "durationSec": RIG_DURATION_SEC,
            "layers": [{
                "id": RIG_LAYER_ID, "type": "shader", "params": params,
                "curves": {
                    controls["x"]: {"keyframes": keys("x")},
                    controls["y"]: {"keyframes": keys("y")},
                },
            }],
        }
        state_before = world.comp_state()
        applied = timed(flow["seconds"], "apply", world.post,
                        "/effects/rig/apply",
                        {"spec": spec, **world.locator()}, 1200)
        if "fallback" in applied:
            reason = applied["fallback"].get("reason", "no reason given")
            raise Fail(f"Resolve could not take this piece: {reason}")
        comp = applied.get("comp_name")
        prev = applied.get("prev_comp_name")
        flow["evidence"]["comp_name"] = comp
        flow["evidence"]["prev_comp_name"] = prev
        flow["evidence"]["bake_note"] = applied.get("notes", "")
        flow["evidence"]["apply_keyframes"] = applied.get("keyframes", 0)
        state_after = world.comp_state()
        if not comp or comp in state_before["names"]:
            raise Fail("apply did not land as a new comp version")
        created["comps"].append(comp)
        new_tools = state_after["tools"].get(comp, 0)
        flow["evidence"]["new_comp_tools"] = new_tools
        if new_tools == 0:
            raise Fail(f"new comp {comp!r} is empty or unreadable")
        prev_tools_before = state_before["tools"].get(prev or "", None)
        prev_tools_after = state_after["tools"].get(prev or "", None)
        flow["evidence"]["prev_comp_tools_before"] = prev_tools_before
        flow["evidence"]["prev_comp_tools_after"] = prev_tools_after
        if prev is not None and prev_tools_before != prev_tools_after:
            raise Fail(f"apply touched the previous comp {prev!r}")
        flow["evidence"]["spline_readback"] = world.keyframe_readback(comp)
        op = {"comp_name": comp, "prev_comp_name": prev,
              "undo": {"prev_comp_name": prev}}
        _, undone_by = timed(flow["seconds"], "undo", world.undo_comp, op,
                             state_before["names"], new_tools)
        flow["evidence"]["undone_by"] = undone_by
        flow["status"] = "PASS"
        if undone_by == "unwind":
            undone = f"build unwound inside {comp}"
        else:
            undone = f"undone to {prev}" if prev else "only version removed"
        flow["reason"] = (
            f"rig {module_id} checked + bundled, new comp {comp} "
            f"with {new_tools} tools, {undone}")
    except Fail as error:
        flow["reason"] = str(error)
    finally:
        if before_health is not None:
            try:
                after_health = health_snapshot(world)
            except Fail:
                after_health = None
            if after_health is not None:
                calls, repairs = health_delta(before_health, after_health,
                                              "modules")
                flow["repairs"] = repairs
                flow["model_calls"] = calls
    return flow


def poll_job(world, request_id: str, timeout_sec: int = 600) -> dict:
    """Wait for an agent job to finish. Raises Fail on failure or timeout."""
    start = time.perf_counter()
    attempt = 0
    while True:
        job = world.get(f"/jobs/{request_id}")
        if job.get("status") == "completed":
            return job
        if job.get("status") in ("failed", "moderated", "canceled"):
            raise Fail(f"job {job['status']}: {job.get('error') or 'no proposal'}")
        if time.perf_counter() - start > timeout_sec:
            raise Fail(f"job {request_id!r} did not finish in time")
        attempt += 1
        time.sleep(min(2 * attempt, 10))


def flow_sound(world, prompts: dict, info: dict, created: dict) -> dict:
    """Run the sound job, apply it to a copy timeline, undo with delete."""
    flow = new_flow("sound", prompts["sound"])
    flow["notes"].append(
        "spans and preview are canned: the check covers plan, items, "
        "apply, and undo, not live dispatch.")
    try:
        before = time.perf_counter()
        total = info["total_frames"]
        rate = int(info["rate"])
        silence = max(rate // 2, 1)
        submitted = world.post("/jobs", {"task": "edit", "input": {
            "brief": flow["prompt"], "proxy_url": info["proxy_url"],
            "total_frames": total, "rate": info["rate"],
            "base_revision": "rev-demo", "target_id": info["music_clip_id"],
            "changeset_id": "cs-demo-sound",
            "spans": [
                {"kind": "silence", "start_frames": 0, "frames": silence},
                {"kind": "silence", "start_frames": max(total - silence, 0),
                 "frames": silence}],
            "preview_urls": ["file:///tmp/demo-check/preview.mp4"]}})
        request_id = submitted.get("request_id", "")
        flow["evidence"]["job_id"] = request_id
        if not request_id:
            raise Fail("job submit answered without a request id")
        job = poll_job(world, request_id)
        flow["seconds"]["generate"] = round(time.perf_counter() - before, 1)
        ops = (job.get("changeset") or {}).get("ops", [])
        op_counts: dict[str, int] = {}
        for op in ops:
            name = op.get("op", "?")
            op_counts[name] = op_counts.get(name, 0) + 1
        skipped = job.get("skipped", [])
        flow["evidence"]["planner"] = job.get("planner") or "rules"
        flow["evidence"]["op_counts"] = op_counts
        flow["evidence"]["job_skipped"] = skipped
        if skipped:
            first = skipped[0]
            raise Fail(f"job skipped {first.get('intent')}: {first.get('reason')}")
        if not any(op.get("op") in ("add_track", "add_clip", "set_gain")
                   for op in ops):
            raise Fail("job finished with no sound items to apply")
        original_before = world.snapshot(TIMELINE)
        flow["evidence"]["original"] = original_before
        applied = timed(
            flow["seconds"], "apply", world.post, "/sounds/apply",
            {"jobId": request_id, "project": PROJECT, "timeline": TIMELINE})
        copy_name = applied.get("timeline_name", "")
        flow["evidence"]["copy_name"] = copy_name
        flow["evidence"]["tracks_added"] = applied.get("tracks_added", 0)
        flow["evidence"]["clips_added"] = applied.get("clips_added", 0)
        flow["evidence"]["fallback"] = applied.get("fallback")
        flow["evidence"]["apply_skipped"] = applied.get("skipped", [])
        if not copy_name or "(sound copy)" not in copy_name:
            raise Fail("apply did not write a (sound copy) timeline")
        created["timelines"].append(copy_name)
        if applied.get("skipped"):
            first = applied["skipped"][0]
            raise Fail(f"apply skipped {first.get('intent')}: {first.get('reason')}")
        original_after = world.snapshot(TIMELINE)
        if original_after != original_before:
            raise Fail("apply changed the original timeline")
        copy = world.snapshot(copy_name)
        flow["evidence"]["copy"] = copy
        grew = (copy["audio_tracks"] > original_before["audio_tracks"]
                or copy["clips"] > original_before["clips"])
        if not grew:
            raise Fail("the sound copy holds no added tracks or clips")
        undone = timed(
            flow["seconds"], "undo", world.post, "/sounds/undo",
            {"timeline_name": copy_name, "original_timeline": TIMELINE,
             "delete_copy": True, "project": PROJECT})
        if undone.get("current_timeline") != TIMELINE:
            raise Fail("undo did not make the original current again")
        if not undone.get("deleted"):
            raise Fail("undo left the sound copy behind")
        try:
            world.snapshot(copy_name)
            raise Fail("undo said deleted but the copy is still there")
        except Fail as error:
            if "is not in" not in str(error):
                raise
        flow["repairs"] = 0
        planner = flow["evidence"]["planner"]
        flow["model_calls"] = 0 if planner == "rules" else "1+ (planner not counted)"
        flow["status"] = "PASS"
        flow["reason"] = (
            f"copy {copy_name} added {applied.get('tracks_added', 0)} track(s) "
            f"and {applied.get('clips_added', 0)} clip(s), original unchanged, "
            f"copy deleted")
    except Fail as error:
        flow["reason"] = str(error)
    return flow


FLOWS = {"effect": flow_effect, "rig": flow_rig, "sound": flow_sound}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chair demo check")
    parser.add_argument("--agent", default="http://127.0.0.1:8787")
    parser.add_argument("--only", choices=("effect", "rig", "sound"), default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    with open(PROMPTS_PATH, encoding="utf-8") as handle:
        prompts = json.load(handle)

    lock = Lock()
    try:
        lock.acquire()
    except Fail as error:
        print(f"demo check refused: {error}")
        return 2

    world = Dry(args.agent) if args.dry_run else Live(args.agent)
    mode = "dry-run" if args.dry_run else "live"
    report = {
        "timestamp": datetime.now(UTC).isoformat(),
        "agent": args.agent, "mode": mode, "project": PROJECT,
        "timeline": TIMELINE, "flows": [], "path": "",
    }
    created: dict = {"comps": [], "timelines": []}
    try:
        try:
            world.get("/health", timeout=10)
        except Fail as error:
            print(f"demo check refused: {error}")
            return 2
        info = world.setup()
        report["info"] = info
        names = [args.only] if args.only else ["effect", "rig", "sound"]
        for name in names:
            try:
                report["flows"].append(FLOWS[name](world, prompts, info, created))
            except Fail as error:
                crashed = new_flow(name, prompts[name])
                crashed["reason"] = str(error)
                report["flows"].append(crashed)
            except Exception as error:
                crashed = new_flow(name, prompts[name])
                crashed["reason"] = f"harness error: {error}"
                crashed["notes"].append(
                    "the script itself broke here, not the product; fix run.py")
                report["flows"].append(crashed)
    except Fail as error:
        print(f"demo check broke: {error}")
        try:
            world.cleanup(created)
        finally:
            lock.release()
        return 2
    restore_error = None
    try:
        world.cleanup(created)
    except Exception as error:
        restore_error = error
    finally:
        lock.release()
    write_report(report)
    print(format_table(report))
    if restore_error is not None:
        print(f"demo check warning: {restore_error}")
        return 2
    return 0 if all_pass(report) else 1


if __name__ == "__main__":
    raise SystemExit(main())

