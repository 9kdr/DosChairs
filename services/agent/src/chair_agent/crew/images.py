"""Muse Image in the crew: generate stills, save them, put them on the cut.

When a graphics task needs pictures, this module generates them for real:
one API call per shot in parallel, files saved under the project's Chair
data dir (never overwriting source media), a provenance sidecar beside
each file, and Shelf visibility on the next assets read. When the brief
asks for the stills on the timeline, the output is a pending changeset
that adds them on a NEW video track of a copy; otherwise the stills ride
as assets on a muse_image piece item.
"""

import base64
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from chair_agent.crew.command import Task
from chair_agent.edit_ops import (
    ChangesetItem,
    still_clip_op,
    stills_track_op,
)
from chair_agent.images import (
    LANDSCAPE_SIZE,
    GeneratedImage,
    ImageAdapter,
    UnexpectedImage,
)

MAX_SHOTS = 8
STILL_FRAMES = 12
RATE = 30.0

_IMAGE_WORDS = (
    "image", "images", "still", "stills", "picture", "pictures",
    "photo", "photos", "key art", "key-art", "thumbnail", "poster",
    "cover art", "match cut", "match-cut", "illustration", "artwork",
    "cutaway", "shot", "shots",
)

_TIMELINE_WORDS = (
    "timeline", "on the cut", "place", "insert", "sequence",
    "match cut", "match-cut", "montage", "slideshow", "trailer",
    "teaser", "beats", "on the beat",
)

_MATCH_CUT_WORDS = ("match cut", "match-cut", "skill: match-cut")

_LANDSCAPE_WORDS = (
    "16:9", "16x9", "wide", "landscape", "cinematic", "key art",
    "key-art", "timeline", "match cut", "match-cut", "sequence",
    "trailer", "teaser", "thumbnail",
)

_SQUARE_WORDS = ("1:1", "square", "avatar")

_PORTRAIT_WORDS = ("9:16", "vertical", "portrait")

_SHARED_PREFIXES = ("same", "all", "both", "shared", "matching", "consistent", "keep")

_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8,
}


class ImageGenerationFailed(Exception):
    pass


def default_adapter() -> ImageAdapter | None:
    """A Muse Image adapter when a key is configured, else None.

    Without a key the graphics runner keeps its piece behavior, so
    keyless runs and tests never touch the image API.
    """
    from chair_agent.client import key_configured
    from chair_agent.images import MUSE_IMAGE_MODEL, build_image_adapter

    if not key_configured("meta"):
        return None
    try:
        return build_image_adapter(MUSE_IMAGE_MODEL)
    except Exception:
        return None


@dataclass
class SavedShot:
    path: Path
    asset_id: str
    prompt: str
    model: str
    created_at: str


def _haystack(goal: str, constraints: Any) -> str:
    parts = [goal or ""]
    if isinstance(constraints, (list, tuple)):
        parts.extend(str(entry) for entry in constraints)
    return " ".join(parts).lower()


def needs_images(goal: str, constraints: Any = ()) -> bool:
    """Whether a graphics task wants generated pictures, not titles."""
    hay = _haystack(goal, constraints)
    if "skill: match-cut" in hay:
        return True
    return any(word in hay for word in _IMAGE_WORDS)


def wants_timeline(goal: str, constraints: Any = ()) -> bool:
    """Whether the brief asks for the stills placed on the cut."""
    hay = _haystack(goal, constraints)
    return any(word in hay for word in _TIMELINE_WORDS)


def match_cut_relevant(goal: str, constraints: Any = ()) -> bool:
    """Whether the match-cut skill applies to this brief."""
    hay = _haystack(goal, constraints)
    return any(word in hay for word in _MATCH_CUT_WORDS)


def shot_count(goal: str) -> int:
    """How many stills the brief asks for: 1 by default, capped at 8."""
    lowered = (goal or "").lower()
    match = re.search(
        r"(\d+)\s*-?\s*(?:shot|still|image|picture|photo)s?\b", lowered
    )
    if match:
        return max(1, min(int(match.group(1)), MAX_SHOTS))
    words = "|".join(_NUMBER_WORDS)
    match = re.search(rf"\b({words})\s*-?\s*(?:shot|still|image|picture)s?\b", lowered)
    if match:
        return _NUMBER_WORDS[match.group(1)]
    return 1


_LOOP_WORDS = tuple(word for word in _IMAGE_WORDS if word not in ("shot", "shots"))


def is_image_brief(brief: str) -> bool:
    """Whether the whole turn is an image brief: skip cut/sound planning.

    The cut/sound pipeline has no image intents, so planning an image
    brief can only misplan it into dispatch. Bare "shot(s)" stays out:
    video briefs talk about shots too; only a count ("5 shots") makes
    it an image brief.
    """
    lowered = (brief or "").lower()
    if any(word in lowered for word in _LOOP_WORDS):
        return True
    return shot_count(brief or "") > 1


def size_for(goal: str) -> str | None:
    """Landscape size for widescreen stills, else the API default square."""
    lowered = (goal or "").lower()
    if any(word in lowered for word in _SQUARE_WORDS):
        return None
    if any(word in lowered for word in _LANDSCAPE_WORDS):
        return LANDSCAPE_SIZE
    return None


def portrait_asked(goal: str) -> bool:
    """Whether the brief wants portrait: noted, since no portrait size is verified."""
    lowered = (goal or "").lower()
    return any(word in lowered for word in _PORTRAIT_WORDS)


def _match_cut_skill() -> str:
    from chair_agent import skills

    try:
        return skills.skill_text("match-cut")
    except Exception:
        return ""


def expand_prompts(
    goal: str, count: int, *, client: Any = None
) -> list[str]:
    """One image prompt per shot: a model call when one is handy, else a split."""
    if client is not None:
        try:
            prompts = _expand_with_model(goal, count, client)
        except Exception:
            prompts = []
        if prompts:
            return prompts[:MAX_SHOTS]
    return _split_prompts(goal, count)


def _expand_with_model(goal: str, count: int, client: Any) -> list[str]:
    from chair_agent.client import Message

    skill = _match_cut_skill() if match_cut_relevant(goal) else ""
    developer = (
        f"You write prompts for an image model. Turn the brief into exactly "
        f"{count} image prompt{'s' if count != 1 else ''}, one per shot, as a "
        f"JSON array of strings (or {{\"prompts\": [...]}}). Plain visual "
        f"description only, no chat."
    )
    if skill:
        developer += f"\n\nFollow this skill when the shots must match:\n{skill}"
    completion = client.execute([
        Message(role="developer", content=developer),
        Message(role="user", content=f"Brief: {goal}"),
    ])
    return _parse_prompt_list(completion.text)


def _parse_prompt_list(text: str) -> list[str]:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = data.get("prompts")
    if not isinstance(data, list):
        return []
    return [item.strip() for item in data if isinstance(item, str) and item.strip()]


def _split_prompts(goal: str, count: int) -> list[str]:
    """Deterministic split: a bare goal stays verbatim, a list splits on commas."""
    goal = (goal or "").strip()
    if count <= 1:
        return [goal]
    body = goal
    if ":" in goal:
        _, _, after = goal.partition(":")
        if after.strip():
            body = after.strip()
    raw = [item.strip() for item in re.split(r"[,;]", body)]
    shared = [
        item for item in raw
        if item.split(" ", 1)[0].lower().rstrip("s") in _SHARED_PREFIXES
    ]
    subjects = [item for item in raw if item and item not in shared]
    if not subjects:
        subjects = [body or goal]
    prompts = []
    for index in range(count):
        if index < len(subjects):
            base = subjects[index]
        elif len(subjects) == 1:
            base = f"{subjects[0]} (shot {index + 1} of {count})"
        else:
            base = f"{subjects[index % len(subjects)]} (variation {index + 1})"
        if shared:
            base = f"{base}, {', '.join(shared)}"
        prompts.append(base)
    return prompts


def _extension(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "webp"  # the live API returns WebP


def _download(url: str) -> bytes:
    if url.startswith("file://"):
        return Path(unquote(urlsplit(url).path)).read_bytes()
    import httpx

    response = httpx.get(url, timeout=60.0)
    response.raise_for_status()
    return response.content


def _image_bytes(image: GeneratedImage) -> bytes:
    if image.b64_json:
        return base64.b64decode(image.b64_json)
    if image.url:
        return _download(image.url)
    raise UnexpectedImage


def _stem(task_id: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", task_id or "").strip("-")
    return stem or "shot"


def _save_shot(
    project_dir: Path, index: int, image: GeneratedImage, *, stem: str
) -> SavedShot:
    from chair_agent.assets import store_generated

    data = _image_bytes(image)
    directory = project_dir / "generated"
    dest = store_generated(directory, f"{stem}-{index + 1:02d}.{_extension(data)}", data)
    created_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    store_generated(
        directory,
        f"{dest.stem}.json",
        json.dumps(
            {"prompt": image.prompt, "model": image.model, "created_at": created_at},
            indent=2,
        ).encode(),
    )
    try:
        asset_id = dest.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        asset_id = dest.name
    return SavedShot(
        path=dest.resolve(), asset_id=asset_id,
        prompt=image.prompt, model=image.model, created_at=created_at,
    )


def generate_and_save(
    prompts: list[str],
    *,
    adapter: ImageAdapter,
    project_dir: Path,
    stem: str,
    size: str | None = None,
    max_workers: int = 4,
) -> tuple[list[SavedShot], list[str]]:
    """One adapter call per prompt in parallel; saved shots plus per-shot errors."""
    if not prompts:
        raise ImageGenerationFailed("no prompts to generate")
    order: list[SavedShot | None] = [None] * len(prompts)
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(prompts))) as pool:
        pending = {
            pool.submit(adapter.generate, prompt, size=size): index
            for index, prompt in enumerate(prompts)
        }
        for future in as_completed(pending):
            index = pending[future]
            try:
                image = future.result()
            except Exception as error:
                errors.append(f"shot {index + 1}: {type(error).__name__}: {error}")
                continue
            try:
                order[index] = _save_shot(project_dir, index, image, stem=stem)
            except Exception as error:
                errors.append(f"shot {index + 1}: {type(error).__name__}: {error}")
    shots = [shot for shot in order if shot is not None]
    if not shots:
        raise ImageGenerationFailed("; ".join(errors) or "no shots generated")
    return shots, errors


def _project_dir(root: Path, project_id: str | None) -> tuple[Path, str | None]:
    """The project's Chair data dir, or the shared generated dir with a note."""
    if project_id and project_id.strip():
        candidate = (root / project_id.strip()).resolve()
        if candidate.is_relative_to(root.resolve()):
            return candidate, None
    return root / "generated", "no project dir; saved under generated/"


def _stills_items(
    task: Task, shots: list[SavedShot], beat_times: list[float]
) -> list[ChangesetItem]:
    track_id = f"video-stills-{_stem(task.id)}"
    step = STILL_FRAMES / RATE
    items = [
        stills_track_op(
            f"{task.id}-stills-track",
            f"New stills track for: {task.goal}",
            track_id=track_id, beat_id=task.beat_id,
        )
    ]
    for index, shot in enumerate(shots):
        if index < len(beat_times):
            start = beat_times[index]
        elif beat_times:
            start = beat_times[-1] + (index - len(beat_times) + 1) * step
        else:
            start = index * step
        items.append(still_clip_op(
            f"{task.id}-still-{index + 1}", track_id,
            f"{_stem(task.id)}-still-{index + 1}",
            f"Still {index + 1}: {shot.prompt[:120]}",
            media_ref=str(shot.path), name=f"Still {index + 1}",
            start_seconds=start, duration_seconds=step, beat_id=task.beat_id,
        ))
    return items


def _asset_items(
    task: Task, shots: list[SavedShot], target_id: str
) -> list[ChangesetItem]:
    """The muse_image piece item, carrying the real generated asset ids."""
    asset_ids = [shot.asset_id for shot in shots]
    try:
        from chair_agent.pieces import apply_piece_defaults, search_pieces

        hits = search_pieces(effect="muse_image", query=task.goal)
        piece = hits[0].piece
        params = apply_piece_defaults(piece, {})
        patch: dict[str, Any] = {
            "piece": piece.id, "effect": piece.effect, "params": params,
            "assets": asset_ids,
        }
        title = piece.title
    except Exception:
        patch = {"effect": "muse_image", "assets": asset_ids}
        title = "Generated stills"
    return [ChangesetItem(
        id=f"{task.id}-muse-image", op="add_effect", targetId=target_id,
        beatId=task.beat_id, rationale=f"{title}: {task.goal}", patch=patch,
    )]


def _clean_beats(beat_times: Any) -> list[float]:
    times: list[float] = []
    if isinstance(beat_times, (list, tuple)):
        for entry in beat_times:
            if isinstance(entry, bool):
                continue
            if isinstance(entry, (int, float)) and math.isfinite(entry) and entry >= 0:
                times.append(float(entry))
    return times


def run_image_task(
    task: Task,
    *,
    client: Any = None,
    adapter: ImageAdapter,
    project_id: str | None = None,
    target_id: str = "timeline-1",
    beat_times: Any = (),
) -> Any:
    """Generate the task's stills, save them, and emit the pending items."""
    from chair_agent.assets import projects_root
    from chair_agent.crew.subagents import SubagentOutput

    count = shot_count(task.goal)
    prompts = expand_prompts(task.goal, count, client=client)
    root = projects_root()
    project_dir, dir_note = _project_dir(root, project_id)
    shots, errors = generate_and_save(
        prompts, adapter=adapter, project_dir=project_dir,
        stem=_stem(task.id), size=size_for(task.goal),
    )
    artifacts = [shot.path.as_uri() for shot in shots]
    if wants_timeline(task.goal, task.constraints):
        items = _stills_items(task, shots, _clean_beats(beat_times))
        notes = f"muse_image: {len(shots)} stills on a new video track"
    else:
        items = _asset_items(task, shots, target_id)
        notes = f"muse_image: {len(shots)} stills as media assets"
    extras = []
    if dir_note:
        extras.append(dir_note)
    if portrait_asked(task.goal):
        extras.append("portrait size unverified; API default used")
    if errors:
        extras.append(f"failures: {'; '.join(errors)}")
    if extras:
        notes += f" ({'; '.join(extras)})"
    return SubagentOutput(artifacts=artifacts, items=items, notes=notes)
