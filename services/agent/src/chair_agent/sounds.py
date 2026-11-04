"""Sound library index and taste-driven cue proposals.

Sources: Mel's own folder (CHAIR_SOUNDS_DIR), the Splice desktop app's
download folder (CHAIR_SPLICE_DIR, default ~/Splice/sounds if it exists;
Splice has no public API so it is just a local folder tagged
source=splice), and Freesound API v2 text search filtered to CC0 only when
FREESOUND_API_KEY is set. Freesound entries keep the preview URL and
attribution; the file lands in the Chair cache folder only on accept, via
POST /sounds/fetch. Source media is never overwritten: cue proposals are
pending changeset items on a NEW audio track, never edits to the timeline.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import wave
from collections.abc import Mapping, Sequence
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.client import Message, ModelClient
from chair_agent.edit_ops import Changeset, ChangesetItem, build_changeset, validate_changeset

AUDIO_EXTENSIONS = frozenset({".wav", ".aif", ".aiff", ".mp3", ".m4a", ".ogg", ".flac"})

# Filename/folder words that name a usable sound. Kept small on purpose:
# the index tags what the file says it is, nothing cleverer.
TAG_WORDS = frozenset({
    "riser", "whoosh", "tape", "stop", "impact", "reverse", "swell", "hit",
    "ambience", "amb", "drone", "stinger", "braam", "downbeat", "uplifter",
    "snap", "thump", "swoosh", "fade",
})

FREESOUND_SEARCH_URL = "https://freesound.org/apiv2/search/text/"
FREESOUND_LICENSE_CC0 = "Creative Commons 0"

TASTE_GUIDE = (
    "Taste guide: less is more — at most one cue per cut or beat moment. "
    "Land every cue on a beat or a cut, never in the middle of a bar. "
    "Never stack two transients (no impact under a tape-stop, no hit on a downbeat that "
    "already has one). Leave dialogue clear: no cue may cover a transcript word span. "
    "Prefer the quietest entry that does the job; gains stay negative."
)

CUE_KINDS = ("tape-stop", "riser", "reverse-swell", "whoosh", "impact")

# Brief words that ask for each cue kind. Rules fallback only.
_KIND_WORDS: dict[str, frozenset[str]] = {
    "tape-stop": frozenset({"tape", "stop", "halt", "brake", "hard cut"}),
    "riser": frozenset({"riser", "build", "uplifter", "tension", "downbeat"}),
    "reverse-swell": frozenset({"swell", "reverse", "re-entry", "reentry", "bloom"}),
    "whoosh": frozenset({"whoosh", "swoosh", "zoom", "whip", "fast"}),
    "impact": frozenset({"impact", "hit", "boom", "braam", "stinger", "thump"}),
}

_KIND_TAGS: dict[str, frozenset[str]] = {
    "tape-stop": frozenset({"tape", "stop"}),
    "riser": frozenset({"riser", "uplifter"}),
    "reverse-swell": frozenset({"reverse", "swell", "fade"}),
    "whoosh": frozenset({"whoosh", "swoosh"}),
    "impact": frozenset({"impact", "hit", "braam", "stinger", "thump", "snap"}),
}


class SoundEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    path: str = Field(min_length=1)
    source: str
    license: str = Field(min_length=1)
    duration: float | None = None
    loudness_lufs: float | None = None
    tags: list[str] = Field(default_factory=list)
    preview_url: str | None = None
    attribution: str | None = None


class Cue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    entry_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    start_seconds: float = Field(ge=0)
    gain_db: float = Field(le=0)
    reason: str = Field(min_length=1)


class CueContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cuts: list[float] = Field(default_factory=list)
    beats: list[float] = Field(default_factory=list)
    words: list[dict] = Field(default_factory=list)


_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, str | None] = {"last_pick_at": None, "last_error": None}
_INDEX_CACHE: dict[str, object] = {"entries": [], "counts": {}}


#: SFX kinds the sidecar can synthesize from scratch (stdlib DSP, no assets).
#: Tags reuse the cue tag map so the two never drift apart.
SYNTH_KINDS = ("riser", "tape-stop", "whoosh", "impact")


def sidecar_url(env: Mapping[str, str] | None = None) -> str:
    """Sidecar base URL: CHAIR_SIDECAR_URL or the local default."""
    from chair_agent.shots import DEFAULT_SIDECAR_URL

    source: Mapping[str, str] = os.environ if env is None else env
    return (source.get("CHAIR_SIDECAR_URL", "").strip() or DEFAULT_SIDECAR_URL)


def sfx_for_kind(entries: Sequence[SoundEntry], kind: str) -> SoundEntry | None:
    """First library entry tagged for the kind. None when the shelf is bare."""
    wanted = _KIND_TAGS.get(kind, frozenset({kind}))
    for entry in entries:
        if wanted & set(entry.tags):
            return entry
    return None


def _poll_sidecar_job(base_url: str, tool: str, body: dict) -> dict:
    """Submit a sidecar job and poll it to done. Raises on failure/timeout."""
    payload = json.dumps(body).encode()
    submit = urllib.request.Request(
        f"{base_url.rstrip('/')}/jobs/{tool}",
        data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(submit, timeout=30) as response:
            ticket = json.loads(response.read().decode("utf-8"))
    except OSError as error:
        raise RuntimeError(f"sidecar {tool} did not accept the job: {error}") from error
    job_id = ticket.get("id")
    if not isinstance(job_id, str) or not job_id:
        raise RuntimeError(f"sidecar {tool} returned no job id")
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f"{base_url.rstrip('/')}/jobs/{job_id}", timeout=30
            ) as response:
                job = json.loads(response.read().decode("utf-8"))
        except OSError as error:
            raise RuntimeError(f"sidecar {tool} job went quiet: {error}") from error
        status = job.get("status")
        if status == "done":
            result = job.get("result")
            if not isinstance(result, dict):
                raise RuntimeError(f"sidecar {tool} finished without a result")
            return result
        if status == "failed":
            raise RuntimeError(f"sidecar {tool} failed: {job.get('error')}")
        if status not in ("queued", "running"):
            raise RuntimeError(f"sidecar {tool} has unknown status: {status!r}")
        time.sleep(0.5)
    raise RuntimeError(f"sidecar {tool} timed out")


def fetch_synth_entry(kind: str, base_url: str) -> SoundEntry:
    """Synthesize one SFX file in the sidecar; index it as a synth entry."""
    if kind not in SYNTH_KINDS:
        raise ValueError(f"sidecar synthesizes {', '.join(SYNTH_KINDS)}: not {kind!r}")
    result = _poll_sidecar_job(base_url, "synth_sfx", {"kind": kind})
    path = result.get("path")
    if not isinstance(path, str) or not path:
        raise RuntimeError("sidecar synth_sfx finished without a path")
    duration = result.get("duration_seconds")
    return SoundEntry(
        id=f"synth:{kind}",
        name=f"{kind} (synth)",
        path=path,
        source="synth",
        license="generated in the sidecar",
        duration=float(duration) if isinstance(duration, (int, float)) else None,
        tags=sorted(_KIND_TAGS[kind]),
    )


def render_tape_stop_entry(
    base_url: str, source: str, *, at_seconds: float, duration: float = 1.5
) -> SoundEntry:
    """Render the program tail through a tape stop in the sidecar.

    Returns the new audio file as a synth entry. Never touches the source.
    """
    result = _poll_sidecar_job(base_url, "tape_stop", {
        "source": source, "at": at_seconds, "duration": duration,
    })
    path = result.get("path")
    if not isinstance(path, str) or not path:
        raise RuntimeError("sidecar tape_stop finished without a path")
    heard = result.get("duration_seconds")
    return SoundEntry(
        id="synth:tape-stop-render",
        name="tape stop (rendered tail)",
        path=path,
        source="synth",
        license="generated in the sidecar",
        duration=float(heard) if isinstance(heard, (int, float)) else duration,
        tags=["tape", "stop"],
    )


def status_snapshot() -> dict[str, object]:
    """Health counters: library size per source, last pick time, last error."""
    with _STATUS_LOCK:
        snapshot = dict(_STATUS)
    counts: dict[str, int] = {"own": 0, "splice": 0, "freesound": 0}
    entries = _INDEX_CACHE.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, SoundEntry):
                counts[entry.source] = counts.get(entry.source, 0) + 1
    snapshot["counts"] = counts
    return snapshot


def _note_pick(error: str | None = None) -> None:
    with _STATUS_LOCK:
        _STATUS["last_pick_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _STATUS["last_error"] = error


def library_dirs(env: Mapping[str, str] | None = None) -> dict[str, Path | None]:
    """Local library roots. Splice defaults to ~/Splice/sounds when present."""
    source: Mapping[str, str] = os.environ if env is None else env
    own = (source.get("CHAIR_SOUNDS_DIR") or "").strip()
    splice = (source.get("CHAIR_SPLICE_DIR") or "").strip()
    default_splice = Path.home() / "Splice" / "sounds"
    return {
        "own": Path(own).expanduser() if own else None,
        "splice": Path(splice).expanduser() if splice else (
            default_splice if default_splice.is_dir() else None
        ),
    }


def cache_dir(env: Mapping[str, str] | None = None) -> Path:
    source: Mapping[str, str] = os.environ if env is None else env
    configured = (source.get("CHAIR_SOUNDS_CACHE") or "").strip()
    if configured:
        path = Path(configured).expanduser()
    else:
        path = Path.home() / ".local" / "share" / "chair" / "agent" / "sounds-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def index_cache_path(env: Mapping[str, str] | None = None) -> Path:
    source: Mapping[str, str] = os.environ if env is None else env
    configured = (source.get("CHAIR_SOUNDS_CACHE") or "").strip()
    base = Path(configured).expanduser() if configured else (
        Path.home() / ".local" / "share" / "chair" / "agent"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base / "sounds-index.json"


def tags_for(path: Path) -> list[str]:
    """Tags from filename and parent-folder words (e.g. riser, whoosh, tape)."""
    words = re.findall(r"[a-z]+", path.stem.lower())
    words += re.findall(r"[a-z]+", path.parent.name.lower())
    seen = [word for word in words if word in TAG_WORDS]
    return sorted(set(seen))


def probe_duration(path: Path) -> float | None:
    """Cheap duration: stdlib wave for .wav, ffprobe otherwise, None when stuck."""
    try:
        if path.suffix.lower() == ".wav":
            with wave.open(str(path), "rb") as handle:
                frames = handle.getnframes()
                rate = handle.getframerate()
                return round(frames / rate, 3) if rate else None
        ffprobe = shutil.which("ffprobe")
        if ffprobe is None:
            return None
        done = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return round(float(done.stdout.strip()), 3) if done.returncode == 0 else None
    except (OSError, ValueError, EOFError):
        return None


def measure_loudness(path: Path) -> float | None:
    """Lazy loudness via ffmpeg ebur128; None when ffmpeg is missing or fails."""
    if shutil.which("ffmpeg") is None:
        return None
    try:
        done = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", str(path), "-map", "0:a:0",
             "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=60,
        )
        log = done.stderr
        at = log.rfind("Summary:")
        if at < 0:
            return None
        match = re.search(r"I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", log[at:])
        return float(match.group(1)) if match else None
    except (OSError, ValueError):
        return None


def scan_folder(source: str, root: Path, *, license: str) -> list[SoundEntry]:
    """Index one local folder. Duration now, loudness lazy (measure on demand)."""
    entries: list[SoundEntry] = []
    if not root.is_dir():
        return entries
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        entries.append(SoundEntry(
            id=f"{source}:{path.stem.lower().replace(' ', '-')}",
            name=path.name,
            path=str(path),
            source=source,
            license=license,
            duration=probe_duration(path),
            loudness_lufs=None,
            tags=tags_for(path),
        ))
    return entries


def search_freesound(
    query: str,
    api_key: str,
    *,
    page_size: int = 15,
    opener: object = None,
) -> list[SoundEntry]:
    """Freesound v2 text search, CC0 only. Preview URL + attribution, no download."""
    params = urllib.parse.urlencode({
        "query": query,
        "filter": f'license:"{FREESOUND_LICENSE_CC0}"',
        "fields": "id,name,duration,license,previews,username,url",
        "page_size": max(1, min(page_size, 50)),
    })
    request = urllib.request.Request(
        f"{FREESOUND_SEARCH_URL}?{params}",
        headers={"Authorization": f"Token {api_key}"},
    )
    open_url = opener or urllib.request.urlopen
    with open_url(request, timeout=30) as response:  # type: ignore[operator]
        payload = json.loads(response.read().decode("utf-8"))
    entries = []
    for hit in payload.get("results", []):
        previews = hit.get("previews") or {}
        entries.append(SoundEntry(
            id=f"freesound:{hit.get('id')}",
            name=str(hit.get("name", "freesound sound")),
            path=str(hit.get("url", "")),
            source="freesound",
            license=str(hit.get("license", FREESOUND_LICENSE_CC0)),
            duration=float(hit.get("duration", 0)) or None,
            loudness_lufs=None,
            tags=tags_for(Path(str(hit.get("name", "")))),
            preview_url=previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3"),
            attribution=f"{hit.get('name')} by {hit.get('username')} ({hit.get('url')})",
        ))
    return entries


def refresh_library(env: Mapping[str, str] | None = None) -> list[SoundEntry]:
    """Rescan local folders and rewrite the disk index cache."""
    entries: list[SoundEntry] = []
    for name, root in library_dirs(env).items():
        if root is not None:
            entries.extend(scan_folder(name, root, license="own"))
    counts = {name: sum(1 for e in entries if e.source == name) for name in ("own", "splice")}
    with _STATUS_LOCK:
        _INDEX_CACHE["entries"] = entries
        _INDEX_CACHE["counts"] = counts
    try:
        index_cache_path(env).write_text(
            json.dumps([e.model_dump(mode="json") for e in entries]), encoding="utf-8",
        )
    except OSError:
        pass
    return entries


def get_library(env: Mapping[str, str] | None = None) -> list[SoundEntry]:
    """Cached index; rescans once per process, loads the disk cache otherwise."""
    with _STATUS_LOCK:
        cached = _INDEX_CACHE.get("entries")
        if isinstance(cached, list) and cached:
            return list(cached)
    try:
        raw = json.loads(index_cache_path(env).read_text(encoding="utf-8"))
        entries = [SoundEntry.model_validate(item) for item in raw]
        with _STATUS_LOCK:
            _INDEX_CACHE["entries"] = entries
        return list(entries)
    except (OSError, ValueError):
        pass
    return refresh_library(env)


def search_library(
    entries: Sequence[SoundEntry],
    *,
    query: str = "",
    tag: str = "",
    source: str = "",
) -> list[SoundEntry]:
    """Filter the index by free text, tag, and source."""
    tokens = [t for t in query.lower().split() if t]
    wanted_tag = tag.strip().lower()
    wanted_source = source.strip().lower()
    hits = []
    for entry in entries:
        if wanted_source and entry.source != wanted_source:
            continue
        if wanted_tag and wanted_tag not in entry.tags:
            continue
        if tokens:
            haystack = f"{entry.name} {' '.join(entry.tags)}".lower()
            if not all(token in haystack for token in tokens):
                continue
        hits.append(entry)
    return hits


def fetch_freesound_entry(
    entry: SoundEntry,
    *,
    api_key: str,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Download a Freesound preview into the Chair cache folder (accept-time only)."""
    if entry.source != "freesound" or not entry.preview_url:
        raise ValueError("only freesound entries with a preview URL can be fetched")
    dest = cache_dir(env) / f"{entry.id.replace(':', '_')}.mp3"
    if dest.is_file():
        return dest
    request = urllib.request.Request(
        entry.preview_url, headers={"Authorization": f"Token {api_key}"},
    )
    with urllib.request.urlopen(request, timeout=60) as response, dest.open("wb") as out:
        shutil.copyfileobj(response, out)
    return dest


def _snap_to_beat(moment: float, beats: Sequence[float], window: float = 0.15) -> float:
    if not beats:
        return round(moment, 3)
    near = min(beats, key=lambda b: abs(b - moment))
    return round(near, 3) if abs(near - moment) <= window else round(moment, 3)


def _covers_dialogue(start: float, duration: float, words: Sequence[dict]) -> bool:
    end = start + duration
    for word in words:
        try:
            wstart, wend = float(word["start"]), float(word["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if start < wend and end > wstart:
            return True
    return False


def _kinds_for_brief(brief: str) -> list[str]:
    lowered = brief.lower()
    return [kind for kind, words in _KIND_WORDS.items()
            if any(w in lowered for w in words)] or ["riser", "whoosh"]


# Kinds whose transient is the END of the file: they lead into a cut or
# downbeat, so start = moment - duration. Hit kinds start ON the moment.
_PRE_HIT_KINDS = frozenset({"riser", "reverse-swell", "whoosh"})


def _cue_start(
    kind: str, moment: float, duration: float, used: Sequence[float],
) -> float | None:
    """Start time for one cue, or None when it must be skipped.

    Pre-hit cues end on the moment (start = moment - duration; None when that
    lands before 0). None also when the transient (the moment itself) falls
    within 0.1s of an already placed one — one cue per moment.
    """
    transient = round(moment, 3)
    if kind in _PRE_HIT_KINDS:
        start = round(moment - duration, 3)
        if start < 0:
            return None
    else:
        start = transient
    if any(abs(transient - taken) <= 0.1 for taken in used):
        return None
    return start


def pick_cues_rules(
    brief: str,
    context: CueContext,
    entries: Sequence[SoundEntry],
) -> list[Cue]:
    """Rules fallback: brief words pick the kind, cuts/beats place it, tags match."""
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    cues: list[Cue] = []
    used_kinds: set[str] = set()
    used_moments: list[float] = []
    moments = list(context.cuts[:4]) or list(context.beats[:4]) or [0.0]
    for kind in _kinds_for_brief(brief):
        if kind in used_kinds:
            continue
        tagged = [e for e in entries if _KIND_TAGS[kind] & set(e.tags)]
        tagged_ids = {e.id for e in tagged}
        candidates = tagged + [e for e in entries if e.tags and e.id not in tagged_ids]
        if not candidates:
            continue
        for attempt in range(len(moments)):
            moment = _snap_to_beat(
                moments[(len(cues) + attempt) % len(moments)], context.beats,
            )
            placed = False
            for match in candidates:
                duration = match.duration or 1.0
                start = _cue_start(kind, moment, duration, used_moments)
                if start is None:  # clamped below 0, or moment already taken
                    continue
                if _covers_dialogue(start, duration, context.words):
                    continue
                gain = -14.0 if kind == "impact" else -10.0
                cues.append(Cue(
                    entry_id=match.id, kind=kind, start_seconds=start, gain_db=gain,
                    reason=f"{kind} from {match.name} lands on the beat at {start:.2f}s.",
                ))
                used_moments.append(round(moment, 3))
                used_kinds.add(kind)
                placed = True
                break
            if placed:  # each moment gets at most one cue; otherwise try the next
                break
        if len(cues) >= 3:  # less is more: never stack cues
            break
    return cues


def build_cue_messages(
    brief: str,
    context: CueContext,
    entries: Sequence[SoundEntry],
) -> list[Message]:
    """Prompt carrying the taste guide, the timeline context, and the catalog."""
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    lines = [
        "You place sound-design cues (tape-stop, riser, reverse-swell, whoosh, impact).",
        TASTE_GUIDE,
        "Reply with a JSON array: "
        '[{"entry_id": "<id>", "kind": "<cue kind>", '
        '"start_seconds": <number>, "gain_db": <number <= 0>, '
        '"reason": "<one line>"}]. At most 3 cues. '
        "start_seconds is the landing moment (the beat or cut): riser, "
        "reverse-swell, and whoosh end on it; tape-stop and impact start on it.",
        f"Cuts at seconds: {context.cuts[:8] or 'none'}",
        f"Beat grid seconds: {context.beats[:16] or 'none'}",
        f"Transcript words: {len(context.words)} spans (never cover them)",
        "Catalog (id | tags | duration s | source):",
    ]
    for entry in entries[:40]:
        lines.append(
            f"- {entry.id} | {', '.join(entry.tags) or 'untagged'} | "
            f"{entry.duration if entry.duration is not None else '?'} | {entry.source}"
        )
    return [
        Message(role="developer", content="\n".join(lines)),
        Message(role="user", content=brief),
    ]


def normalize_cues(
    cues: Sequence[Cue],
    context: CueContext,
    entries: Sequence[SoundEntry],
) -> list[Cue]:
    """Enforce the taste rules on model cues with the same helper as rules.

    start_seconds names the landing moment: pre-hit kinds back up so they end
    on it, hit kinds start on it. Colliding (within 0.1s) or dialogue-covering
    cues are dropped.
    """
    by_id = {entry.id: entry for entry in entries}
    kept: list[Cue] = []
    used_moments: list[float] = []
    for cue in cues:
        entry = by_id.get(cue.entry_id)
        if entry is None:
            continue
        duration = entry.duration or 1.0
        moment = _snap_to_beat(cue.start_seconds, context.beats)
        start = _cue_start(cue.kind, moment, duration, used_moments)
        if start is None:
            continue
        if _covers_dialogue(start, duration, context.words):
            continue
        used_moments.append(round(moment, 3))
        kept.append(cue if cue.start_seconds == start
                    else cue.model_copy(update={"start_seconds": start}))
    return kept


def _parse_cue_completion(text: str, entries: Sequence[SoundEntry]) -> list[Cue]:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        lines = trimmed.splitlines()[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        trimmed = "\n".join(lines).strip()
    payload = json.loads(trimmed)
    if not isinstance(payload, list):
        raise ValueError("model cues must be a JSON array")
    by_id = {entry.id: entry for entry in entries}
    cues = []
    for raw in payload[:3]:
        if not isinstance(raw, dict) or raw.get("entry_id") not in by_id:
            raise ValueError("each cue needs a catalog entry_id")
        cues.append(Cue.model_validate(raw))
    return cues


def pick_cues(
    brief: str,
    context: CueContext,
    entries: Sequence[SoundEntry],
    *,
    client: ModelClient | None = None,
) -> tuple[list[Cue], str]:
    """Model first (executor chat path), rules when no key or on model error."""
    model_error: str | None = None
    if client is not None:
        try:
            completion = client.execute(build_cue_messages(brief, context, entries))
            raw = _parse_cue_completion(completion.text, entries)
            cues = normalize_cues(raw, context, entries)
            _note_pick()
            return cues, "model"
        except Exception as error:
            model_error = f"model pick failed, rules used: {error}"
    cues = pick_cues_rules(brief, context, entries)
    _note_pick(model_error)
    return cues, "rules" if client is None else "rules-fallback"


def cues_to_changeset(
    cues: Sequence[Cue],
    entries: Sequence[SoundEntry],
    *,
    changeset_id: str,
    base_revision: str,
    track_id: str = "audio-sfx-1",
) -> Changeset:
    """Pending items only: a NEW audio track plus one add_clip per cue. No apply."""
    by_id = {entry.id: entry for entry in entries}
    items: list[ChangesetItem] = [
        ChangesetItem(
            id="track-sfx-1", op="add_track", rationale="New audio track for sound cues.",
            patch={"track": {"id": track_id, "kind": "audio"}},
        )
    ]
    for index, cue in enumerate(cues):
        entry = by_id.get(cue.entry_id)
        if entry is None:
            raise ValueError(f"cue uses unknown entry: {cue.entry_id!r}")
        items.append(ChangesetItem(
            id=f"cue-{index + 1}", op="add_clip", targetId=track_id, rationale=cue.reason,
            patch={
                "mediaRef": entry.path,
                "source": entry.source,
                "license": entry.license,
                "startSeconds": cue.start_seconds,
                "kind": cue.kind,
                "attribution": entry.attribution,
            },
        ))
        items.append(ChangesetItem(
            id=f"cue-{index + 1}-gain", op="set_gain", targetId=track_id,
            rationale=f"Keep the {cue.kind} under the mix at {cue.gain_db} dB.",
            patch={"gainDb": cue.gain_db, "clipId": f"cue-{index + 1}"},
        ))
    changeset = build_changeset(changeset_id, base_revision, items, summary="Sound cues")
    dumped = changeset.model_dump(mode="json", by_alias=True, exclude_none=True)
    return validate_changeset(dumped)
