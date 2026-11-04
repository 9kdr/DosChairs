"""Per-project plan: a user-facing front plus an agent-facing back (issue #261).

The front is what Mel edits: script text, beats, and a style board. The
back is what agents read: ordered tasks, do/don't constraints, and a
one-time vision digest per board image. The back goes stale whenever the
front hash moves, so agents never work from yesterday's plan.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from chair_agent.client import Message, ModelClient

SCHEMA_VERSION = "0.1.0"

BoardKind = Literal["style", "campaign", "reference", "link"]

_LOCK = threading.Lock()


class PlanBeat(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    role: str = ""
    text: str = ""
    start_sec: float | None = Field(default=None, alias="startSec", ge=0)
    end_sec: float | None = Field(default=None, alias="endSec", ge=0)


class BoardItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    kind: BoardKind = "reference"
    title: str = ""
    images: list[str] = Field(default_factory=list)
    url: str | None = None
    notes: str = ""
    tags: list[str] = Field(default_factory=list)


class PlanFront(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    script_md: str = ""
    beats: list[PlanBeat] = Field(default_factory=list)
    board: list[BoardItem] = Field(default_factory=list)


class BackTask(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    detail: str = ""


class BackConstraints(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    do: list[str] = Field(default_factory=list)
    dont: list[str] = Field(default_factory=list)


class BoardDigest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    palette: list[str] = Field(default_factory=list)
    mood: str = Field(min_length=1)
    motion_words: list[str] = Field(default_factory=list, alias="motionWords")
    keywords: list[str] = Field(default_factory=list)


class PlanBack(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    tasks: list[BackTask] = Field(default_factory=list)
    constraints: BackConstraints = Field(default_factory=BackConstraints)
    digests: dict[str, BoardDigest] = Field(default_factory=dict)
    front_hash: str = Field(default="", alias="frontHash")
    stale: bool = False


class ProjectPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal["0.1.0"] = Field(default=SCHEMA_VERSION, alias="schemaVersion")
    id: str = Field(min_length=1)
    status: Literal["draft", "ready"] = "draft"
    front: PlanFront = Field(default_factory=PlanFront)
    front_hash: str = Field(default="", alias="frontHash")
    back: PlanBack = Field(default_factory=PlanBack)


class PlanError(ValueError):
    pass


def _schema_path() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root:
        return Path(root) / "schemas" / "project-plan.schema.json"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "schemas" / "project-plan.schema.json"
        if candidate.is_file():
            return candidate
    raise PlanError("schemas/project-plan.schema.json not found")


def validate_project_plan(data: Mapping[str, Any]) -> ProjectPlan:
    """Validate raw plan data against schemas/project-plan.schema.json."""
    if not isinstance(data, Mapping):
        raise PlanError("project plan must be an object")
    try:
        schema = json.loads(_schema_path().read_text(encoding="utf-8"))
    except OSError as error:
        raise PlanError(f"cannot read project-plan schema: {error}") from error
    errors = list(Draft202012Validator(schema).iter_errors(dict(data)))
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.absolute_path) or "project plan"
        raise PlanError(f"invalid project plan at {where}: {first.message}")
    try:
        return ProjectPlan.model_validate(data)
    except ValidationError as error:
        raise PlanError(f"invalid project plan: {error}") from error


def _state_dir(env: Mapping[str, str] | None = None) -> Path:
    source: Mapping[str, str] = os.environ if env is None else env
    root = (source.get("CHAIR_AGENT_STATE_DIR") or "").strip()
    base = Path(root).expanduser() if root else (
        Path.home() / ".local" / "share" / "chair" / "agent"
    )
    plans = base / "plans"
    plans.mkdir(parents=True, exist_ok=True)
    return plans


def _safe_id(project_id: str) -> str:
    return "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in project_id) or "plan"


def _store_path(project_id: str, env: Mapping[str, str] | None = None) -> Path:
    return _state_dir(env) / f"{_safe_id(project_id)}.json"


def front_hash(front: PlanFront) -> str:
    """Hash of the canonical front JSON; the back is stale when this moves."""
    dumped = front.model_dump(mode="json", by_alias=True, exclude_none=True)
    canonical = json.dumps(dumped, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def _default_plan(project_id: str) -> ProjectPlan:
    front = PlanFront()
    return ProjectPlan(id=project_id, front=front, frontHash=front_hash(front))


def load_plan(
    project_id: str, env: Mapping[str, str] | None = None
) -> ProjectPlan:
    """Stored plan for a project, or an empty draft when nothing is stored."""
    if not project_id.strip():
        raise PlanError("a project id is needed to load its plan")
    try:
        raw = json.loads(_store_path(project_id, env).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _default_plan(project_id)
    try:
        plan = validate_project_plan(raw)
    except PlanError:
        return _default_plan(project_id)
    if plan.id != project_id:
        return _default_plan(project_id)
    return plan


def _dump(plan: ProjectPlan) -> dict[str, Any]:
    return plan.model_dump(mode="json", by_alias=True, exclude_none=True)


def _save(plan: ProjectPlan, env: Mapping[str, str] | None = None) -> None:
    with _LOCK:
        _store_path(plan.id, env).write_text(json.dumps(_dump(plan)), encoding="utf-8")


def plan_payload(plan: ProjectPlan) -> dict[str, Any]:
    """Serve shape: the stored plan with the staleness flag computed fresh."""
    dumped = _dump(plan)
    back = dumped["back"]
    back["stale"] = bool(back["tasks"]) and back.get("frontHash") != dumped["frontHash"]
    return dumped


def save_front(
    project_id: str, front_data: Any, env: Mapping[str, str] | None = None
) -> ProjectPlan:
    """Replace the front; the stored back stays and reads stale on mismatch."""
    if not isinstance(front_data, Mapping):
        raise PlanError("plan front must be an object")
    try:
        front = PlanFront.model_validate(front_data)
    except ValidationError as error:
        raise PlanError(f"invalid plan front: {error}") from error
    stored = load_plan(project_id, env)
    plan = validate_project_plan(
        {
            "schemaVersion": "0.1.0",
            "id": project_id,
            "status": stored.status,
            "front": front.model_dump(mode="json", by_alias=True, exclude_none=True),
            "frontHash": front_hash(front),
            "back": stored.back.model_dump(mode="json", by_alias=True, exclude_none=True),
        }
    )
    _save(plan, env)
    return plan


def _planner_client(client: ModelClient | None) -> ModelClient:
    if client is not None:
        return client
    from chair_agent.client import build_client, load_settings

    settings = load_settings()
    if not settings.models.planner or not settings.api_key:
        raise PlanError(
            "plan generation needs a model: set META_API_KEY and "
            "CHAIR_PLANNER_MODEL (e.g. muse-spark-1)"
        )
    try:
        return build_client()
    except Exception as error:
        raise PlanError(f"plan model unavailable: {error}") from error


def _parse_back_completion(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    try:
        payload = json.loads(trimmed)
    except ValueError as error:
        raise PlanError(f"plan model did not return JSON: {error}") from error
    if not isinstance(payload, dict):
        raise PlanError("plan model did not return a JSON object")
    return payload


def _back_prompt(front: PlanFront) -> str:
    lines = [
        "You plan video edits. Turn this user-facing plan into an agent-facing "
        "back plan. Reply with ONE JSON object and nothing else: "
        '{"tasks": [{"id": "...", "title": "...", "detail": "..."}], '
        '"constraints": {"do": [...], "dont": [...]}}. '
        "Keep tasks ordered and concrete; never touch source media, only copies. "
        "Constraints always forbid overwriting source video or audio.",
        f"Script:\n{front.script_md.strip() or '(no script yet)'}",
    ]
    for beat in front.beats:
        span = ""
        if beat.start_sec is not None or beat.end_sec is not None:
            span = f" [{beat.start_sec or 0}-{beat.end_sec if beat.end_sec is not None else '?'}s]"
        lines.append(f"Beat {beat.id} ({beat.role or 'beat'}){span}: {beat.text}")
    for item in front.board:
        lines.append(
            f"Board {item.id} [{item.kind}] {item.title}: "
            f"{item.notes or 'no notes'} (tags: {', '.join(item.tags) or 'none'})"
        )
    return "\n".join(lines)


def generate_back(
    project_id: str,
    *,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
) -> ProjectPlan:
    """Build the back plan from the front with one Spark call; stamp its hash."""
    plan = load_plan(project_id, env)
    model = _planner_client(client)
    completion = model.complete(
        "planner", [Message(role="user", content=_back_prompt(plan.front))]
    )
    payload = _parse_back_completion(completion.text)
    try:
        tasks = [BackTask.model_validate(item) for item in payload.get("tasks", [])]
        constraints = BackConstraints.model_validate(payload.get("constraints", {}))
    except ValidationError as error:
        raise PlanError(f"plan model returned a bad back plan: {error}") from error
    if not tasks:
        raise PlanError("plan model returned no tasks")
    digest_store = plan.back.digests
    for item in plan.front.board:
        if item.images and item.id not in digest_store:
            try:
                digest_store[item.id] = run_digest(item.images[0], client=model)
            except PlanError:
                continue
    updated = ProjectPlan.model_validate(
        {
            "schemaVersion": "0.1.0",
            "id": project_id,
            "status": plan.status,
            "front": plan.front.model_dump(mode="json", by_alias=True, exclude_none=True),
            "frontHash": plan.front_hash,
            "back": {
                "tasks": [task.model_dump(mode="json") for task in tasks],
                "constraints": constraints.model_dump(mode="json"),
                "digests": {
                    key: value.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for key, value in digest_store.items()
                },
                "frontHash": plan.front_hash,
            },
        }
    )
    _save(updated, env)
    return updated


def _image_part(image: str) -> dict[str, Any]:
    value = (image or "").strip()
    if not value:
        raise PlanError("a board digest needs an image URL or file path")
    if value.startswith("data:") or value.startswith(("http://", "https://")):
        return {"type": "image_url", "image_url": {"url": value}}
    try:
        raw = Path(value).expanduser().read_bytes()
    except OSError as error:
        raise PlanError(f"board image unreadable: {value}: {error}") from error
    encoded = base64.b64encode(raw).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}}


def run_digest(
    image: str, client: ModelClient | None = None
) -> BoardDigest:
    """One Spark vision pass over a board image: palette, mood, motion, keywords."""
    model = _planner_client(client)
    completion = model.complete(
        "planner",
        [
            Message(
                role="developer",
                content=(
                    "Describe this reference frame for a video editor in ONE "
                    "JSON object and nothing else: "
                    '{"palette": ["#rrggbb", ...], "mood": "...", '
                    '"motionWords": [...], "keywords": [...]}. '
                    "Palette holds up to 5 dominant hex colors. Mood is one "
                    "short phrase. Motion words suggest camera moves the "
                    "still invites (e.g. slow push-in)."
                ),
            ),
            Message(
                role="user",
                content=[
                    {"type": "text", "text": "Digest this board image."},
                    _image_part(image),
                ],
            ),
        ],
    )
    payload = _parse_back_completion(completion.text)
    try:
        return BoardDigest.model_validate(payload)
    except ValidationError as error:
        raise PlanError(f"plan model returned a bad digest: {error}") from error


def digest_item(
    project_id: str,
    item_id: str,
    *,
    client: ModelClient | None = None,
    env: Mapping[str, str] | None = None,
) -> ProjectPlan:
    """Digest one board item's first image; cached digests are returned untouched."""
    plan = load_plan(project_id, env)
    item = next((entry for entry in plan.front.board if entry.id == item_id), None)
    if item is None:
        raise PlanError(f"unknown board item: {item_id!r}")
    if item.id in plan.back.digests:
        return plan
    if not item.images:
        raise PlanError(f"board item {item_id!r} has no image to digest")
    digest = run_digest(item.images[0], client=client)
    digests = dict(plan.back.digests)
    digests[item.id] = digest
    updated = ProjectPlan.model_validate(
        {
            **plan.model_dump(mode="json", by_alias=True, exclude_none=True),
            "back": {
                **plan.back.model_dump(mode="json", by_alias=True, exclude_none=True),
                "digests": {
                    key: value.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for key, value in digests.items()
                },
            },
        }
    )
    _save(updated, env)
    return updated


def iter_board_items(
    env: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Every board item in every stored plan, for @-mention resolution."""
    items: list[dict[str, Any]] = []
    try:
        files = sorted(_state_dir(env).glob("*.json"))
    except OSError:
        return items
    for path in files:
        try:
            plan = validate_project_plan(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, PlanError):
            continue
        for entry in plan.front.board:
            digest = plan.back.digests.get(entry.id)
            items.append(
                {
                    "project_id": plan.id,
                    "id": entry.id,
                    "title": entry.title,
                    "kind": entry.kind,
                    "notes": entry.notes,
                    "tags": list(entry.tags),
                    "image": entry.images[0] if entry.images else None,
                    "url": entry.url,
                    "digest": digest.model_dump(mode="json", by_alias=True, exclude_none=True)
                    if digest is not None
                    else None,
                }
            )
    return items


def find_board_item(
    key: str, env: Mapping[str, str] | None = None
) -> dict[str, Any] | None:
    """Match a board item by id or title, for `board:<id>` and `@title` refs."""
    norm = key.strip()
    if norm.startswith("@"):
        norm = norm[1:]
    if norm.startswith("board:"):
        norm = norm[len("board:") :]
    norm = norm.strip().casefold()
    if not norm:
        return None
    slug = _slug(norm)
    for item in iter_board_items(env):
        if item["id"].casefold() == norm or _slug(item["title"]) == slug:
            return item
    return None


def _slug(text: str) -> str:
    cleaned: list[str] = []
    dash = False
    for char in text.casefold():
        if char.isalnum():
            cleaned.append(char)
            dash = False
        elif not dash:
            cleaned.append("-")
            dash = True
    return "".join(cleaned).strip("-")
