"""Mouse-rig brain: a brief becomes a Rig the expressive cursor sim can run.

The editor describes a cursor move in words ("swings in with momentum,
overshoots, settles, then bounces on click") and the model drafts a Rig:
a rough inputPath plus spring physics params matching
packages/effects/src/rig.ts. The caller bakes it (node sim) and applies the
baked keys to Resolve through POST /effects/rig/apply, which threads them
into add_effect as a new comp version. Nothing here touches the timeline.

Pipeline: generate (model draft + validate + one repair retry, then a clear
error), mirroring effects.py's model call, validation, and repair pattern.
"""

import threading
import time
from collections.abc import Mapping
from typing import Any

from chair_agent.client import Message, ModelClient

MAX_GENERATE_REPAIRS = 2

PHYSICS_RANGES = (
    "stiffness 20..300 (default 90), damping 2..40 (default 12), "
    "mass 0.2..5 (default 1)"
)

RIG_SHAPE = """{
  "inputPath": [{"time": <seconds>, "x": <pixels from left>, "y": <pixels from top>}],
  "stiffness": 90, "damping": 12, "mass": 1,
  "swing": true, "tilt": true, "squash": true, "overshoot": true
}"""


class InvalidRig(ValueError):
    pass


_MODEL_ERROR_PREFIXES = (
    "rig generation needs a model",
    "rig model unavailable",
    "model call failed",
)


def error_status(error: InvalidRig) -> int:
    """HTTP status for a rig failure: 502 model down, else 400."""
    message = str(error)
    if message.startswith(_MODEL_ERROR_PREFIXES):
        return 502
    return 400


_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "generated": 0,
    "repairs": 0,
    "last_latency_ms": None,
    "last_error": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: rigs generated, repairs, latency, error."""
    with _STATUS_LOCK:
        return dict(_STATUS)


def _note_generated(latency_ms: float, error: str | None = None) -> None:
    with _STATUS_LOCK:
        if error is None:
            _STATUS["generated"] += 1
        _STATUS["last_latency_ms"] = latency_ms
        _STATUS["last_error"] = error


def _note_repair() -> None:
    with _STATUS_LOCK:
        _STATUS["repairs"] += 1


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and (
        value == value and value not in (float("inf"), float("-inf"))
    )


def validate_rig(
    data: Mapping[str, Any],
    *,
    width: float | None = None,
    height: float | None = None,
    duration_sec: float | None = None,
) -> dict[str, Any]:
    """Validate raw model output as a Rig. Raises InvalidRig naming the gap.

    With the canvas and duration given, keys outside the frame or past the
    end are rejected (the generate repair retry asks the model to fix them),
    so a bad draft can never fly the cursor off screen.
    """
    if not isinstance(data, Mapping):
        raise InvalidRig("rig must be an object")
    path = data.get("inputPath")
    if not isinstance(path, list) or not path:
        raise InvalidRig("rig needs a non-empty 'inputPath' key list")
    seen = -1.0
    for index, key in enumerate(path):
        if not isinstance(key, Mapping):
            raise InvalidRig(f"rig inputPath[{index}] must be an object")
        for field in ("time", "x", "y"):
            if not _finite(key.get(field)):
                raise InvalidRig(f"rig inputPath[{index}] needs a finite '{field}'")
        moment = float(key["time"])
        if moment < 0:
            raise InvalidRig(f"rig inputPath[{index}] time must be >= 0")
        if duration_sec is not None and moment > duration_sec:
            raise InvalidRig(
                f"rig inputPath[{index}] time {moment:g}s is past the "
                f"{duration_sec:g}s duration"
            )
        if moment < seen:
            raise InvalidRig("rig inputPath times must not go backwards")
        seen = moment
        for field, bound in (("x", width), ("y", height)):
            if bound is not None and not 0 <= float(key[field]) <= bound:
                raise InvalidRig(
                    f"rig inputPath[{index}] {field} {key[field]} is outside "
                    f"the 0..{bound:g} canvas"
                )
    for field in ("stiffness", "damping", "mass"):
        value = data.get(field)
        if value is None:
            continue
        if not _finite(value) or float(value) <= 0:
            raise InvalidRig(f"rig '{field}' must be a positive number")
    for field in ("swing", "tilt", "squash", "overshoot"):
        value = data.get(field)
        if value is not None and not isinstance(value, bool):
            raise InvalidRig(f"rig '{field}' must be a boolean")
    return dict(data)


def build_rig_messages(
    brief: str,
    *,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
) -> list[Message]:
    """Prompt carrying the Rig shape, the physics ranges, and the canvas."""
    if not brief.strip():
        raise InvalidRig("generate needs a non-empty 'brief'")
    developer = "\n".join([
        "You draft expressive mouse-rig briefs for the Chair cursor rig.",
        "Reply with ONE JSON object and nothing else, a Rig exactly like:",
        RIG_SHAPE,
        "inputPath is the ROUGH path the cursor should chase, in canvas "
        "pixels from the top-left, over the move only (the sim settles "
        "afterwards on its own): 2-6 keys with times in seconds.",
        f"Physics: {PHYSICS_RANGES}. Lower damping (under critical) "
        "overshoots; set overshoot false only for a dead stop.",
        "Flags: swing (pendulum lag), tilt (lean into velocity), squash "
        "(squash-and-stretch landing) default true; turn one off only when "
        "the brief rules it out (a click bounce keeps squash).",
        "Motion taste: momentum in, overshoot, settle; stagger beats 2-4 "
        "frames apart; a click is a quick down-up key pair at the end, not "
        "a slide.",
        f"Canvas: {width}x{height}, {fps} fps, {duration_sec}s. Keep every "
        "key inside the canvas and inside the duration.",
    ])
    return [
        Message(role="developer", content=developer),
        Message(role="user", content=brief.strip()),
    ]


def _parse_rig_completion(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    import json as _json

    try:
        payload = _json.loads(trimmed)
    except _json.JSONDecodeError as error:
        raise InvalidRig(f"model did not return JSON: {error}") from error
    if not isinstance(payload, dict):
        raise InvalidRig("model must return one JSON object, not a list or scalar")
    return payload


def build_repair_messages(
    bad_rig: Mapping[str, Any] | str, errors: list[str],
) -> list[Message]:
    reasons = "\n".join(f"- {error}" for error in errors) or "- (unknown reason)"
    if isinstance(bad_rig, str):
        developer = (
            "You draft expressive mouse rigs. Your last draft was not "
            "valid JSON. Reply with ONE fixed JSON object and nothing else, "
            "changing as little as possible while fixing every error:\n"
            f"{reasons}"
        )
        user_content = bad_rig
    else:
        import json as _json

        developer = (
            "You draft expressive mouse rigs. Your last draft failed "
            "validation. Reply with ONE fixed JSON object and nothing else, "
            "changing as little as possible while fixing every error:\n"
            f"{reasons}"
        )
        user_content = _json.dumps(dict(bad_rig))
    return [
        Message(role="developer", content=developer),
        Message(role="user", content=user_content),
    ]


def _model_client() -> ModelClient:
    from chair_agent.client import build_client, load_settings

    settings = load_settings()
    if not settings.models.executor or not settings.api_key:
        raise InvalidRig(
            "rig generation needs a model: set META_API_KEY and "
            "CHAIR_EXECUTOR_MODEL (e.g. muse-spark-1)"
        )
    try:
        return build_client()
    except Exception as error:
        raise InvalidRig(f"rig model unavailable: {error}") from error


def generate_rig(
    brief: str,
    *,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
    client: ModelClient | None = None,
) -> dict[str, Any]:
    """Draft, validate (one repair retry), and return {"rig", "notes"}."""
    if width <= 0 or height <= 0:
        raise InvalidRig("canvas width and height must be positive integers")
    if fps <= 0 or duration_sec <= 0:
        raise InvalidRig("fps and durationSec must be positive numbers")
    active = client if client is not None else _model_client()
    messages = build_rig_messages(
        brief, width=width, height=height, fps=fps, duration_sec=duration_sec,
    )
    started = time.perf_counter()
    notes = "Drafted by Muse Spark from the brief."
    try:
        completion = active.execute(messages)
        text = completion.text
        parsed: dict[str, Any] | None = None
        malformed = False
        errors: list[str] = []
        repairs = 0
        while True:
            try:
                parsed = _parse_rig_completion(text)
                rig = validate_rig(
                    parsed, width=width, height=height, duration_sec=duration_sec,
                )
                break
            except InvalidRig as error:
                errors.append(str(error))
                if repairs >= MAX_GENERATE_REPAIRS:
                    raise InvalidRig(
                        "model output failed validation "
                        f"{MAX_GENERATE_REPAIRS + 1} times; last error: {error}"
                    ) from error
                repairs += 1
                _note_repair()
                bad: Mapping[str, Any] | str = parsed if parsed is not None else text
                malformed = malformed or isinstance(bad, str)
                repair = active.execute(build_repair_messages(bad, list(errors)))
                text = repair.text
                parsed = None
        if repairs:
            if malformed:
                notes += " First draft was malformed JSON; repaired on retry."
            else:
                notes += " First draft failed validation; repaired on retry."
    except InvalidRig as error:
        _note_generated(round((time.perf_counter() - started) * 1000, 1), str(error))
        raise
    except Exception as error:
        _note_generated(
            round((time.perf_counter() - started) * 1000, 1),
            f"model call failed: {error}",
        )
        raise InvalidRig(f"model call failed: {error}") from error
    _note_generated(round((time.perf_counter() - started) * 1000, 1))
    return {"rig": rig, "notes": notes}
