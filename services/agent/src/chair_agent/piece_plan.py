"""Piece plans: split a brief into parts and route each part before generating.

A loose ask ("a kinetic title saying LAUNCH over a liquid gradient with
grain") is really several jobs. plan_piece splits it into parts and routes
each one, in order:

1. ``native``: a Resolve/Fusion tool the adapter can build (Text+,
   Background, FilmGrain, ...), gated on the adapter capability manifest.
2. ``reuse``: an existing gold library piece, adapted with props.
3. ``new``: a tightly scoped brief for one new piece.

A one-element loose ask reuses the library when it names a gold piece,
else it is new: a lone ask is a piece order, never a dead end. An explicit
piece spec (a "Props:" list or a code fence) is already a custom-piece
order and never reroutes. Multi-part briefs route each part fully: native
layers become placement guidance, reuse parts adapt their gold module,
and only the new parts reach the model. Native parts name the Fusion tool
and settings so the shared Fusion builder can take them later.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Literal

from chair_resolve import manifest as resolve_manifest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field

from chair_agent import skills

SCHEMA_VERSION = "0.1.0"

# A literal the part must render (Text+ content): "saying LAUNCH", a quoted
# string. Literals never split and never block native routing.
_LITERAL_AFTER = re.compile(
    r"\b(?:saying|says|reads?)\s+[\"']?([^\"';.]+?)[\"']?"
    r"(?=\s+over\s+|\s+with\s+|\s+plus\s+|\s+and\s+|[.;]|$)",
    re.IGNORECASE,
)
_QUOTED = re.compile(r"[\"']([^\"']+)[\"']")
_HEX_TAIL = re.compile(r"\s*#[0-9a-fA-F]{6}\b.*$")
_HEX_PREP = re.compile(r"\s+(?:in|on|with|and)\s*$", re.IGNORECASE)

# word -> (Fusion tool, base settings); mirrors the Fusion skill's "Safe
# native tools" table. _TOOL_RANK picks among several nouns in one part.
_NATIVE_NOUNS: dict[str, tuple[str, dict[str, Any]]] = {
    **dict.fromkeys(
        (
            "text", "title", "titles", "caption", "captions", "label",
            "labels", "word", "words", "letter", "letters", "heading",
            "headings", "subtitle", "subtitles", "type", "typography",
        ),
        ("Text+", {}),
    ),
    **dict.fromkeys(
        ("background", "backdrop", "wallpaper", "bg"), ("Background", {})
    ),
    "gradient": ("Background", {"mode": "gradient"}),
    "gradients": ("Background", {"mode": "gradient"}),
    "grain": ("FilmGrain", {}),
    "noise": ("FastNoise", {}),
    "dither": ("Custom", {"look": "dither"}),
    "halftone": ("Custom", {"look": "halftone"}),
    "blur": ("Blur", {}),
    "glow": ("SoftGlow", {}),
    **dict.fromkeys(
        ("grade", "color", "colors", "correction"), ("ColorCorrector", {})
    ),
    "mask": ("Rectangle", {"as": "mask"}),
    "masks": ("Rectangle", {"as": "mask"}),
    **dict.fromkeys(
        (
            "move", "moves", "moving", "scale", "scales", "scaling",
            "rotate", "rotates", "rotation", "position", "fade", "fades",
            "fading", "slide", "slides", "sliding", "zoom", "zooms", "pan",
        ),
        ("Transform", {}),
    ),
}

# Words that may ride along in a native part without blocking it: glue,
# the saying-verbs, and plain visual adjectives.
_COVERED = frozenset(
    {
        "a", "an", "the", "with", "over", "and", "plus", "of", "in",
        "on", "for", "from", "to", "by", "as", "at", "into", "that",
        "this", "it", "its", "is", "are", "be", "say", "says",
        "saying", "read", "reads", "reading", "effect", "effects",
        "film", "motion",
        "kinetic", "animated",
        "soft", "fast", "slow", "subtle", "gentle", "smooth", "dark",
        "light", "bright", "thin", "thick", "big", "small", "short",
        "long", "classic", "simple", "solid", "plain",
    }
    | set(_NATIVE_NOUNS)
)

# When a part names several tools, the subject wins over the modifier: a
# "sliding title" is Text+, not a Transform; motion alone stays Transform.
_TOOL_RANK = {
    "Text+": 0,
    "Background": 1,
    "FilmGrain": 2,
    "FastNoise": 2,
    "Custom": 2,
    "Blur": 2,
    "SoftGlow": 2,
    "ColorCorrector": 2,
    "Rectangle": 2,
    "Transform": 3,
}

# "with X" splits only when X is a standalone effect layer ("with grain"
# splits; "with big words" and "with an overshooting ease" do not).
_WITH_NOUNS = frozenset({"grain", "glow", "blur", "dither", "halftone", "noise"})
_WITH_PATTERN = re.compile(
    r"\s+with\s+(?:film\s+grain|(?:a\s+|an\s+|the\s+)?(?:"
    + "|".join(sorted(_WITH_NOUNS))
    + r")\b)",
    re.IGNORECASE,
)
_OVER_PATTERN = re.compile(r"\s+over\s+", re.IGNORECASE)
_PLUS_PATTERN = re.compile(r"\s+(?:plus|\+)\s+", re.IGNORECASE)
_AND_PATTERN = re.compile(r"\s+and\s+", re.IGNORECASE)

# "over <time>" is a duration, not a layer ("drains over the duration").
_OVER_TIME = frozenset(
    {
        "duration", "time", "shot", "clip", "video", "timeline",
        "footage", "track", "seconds", "second", "frames", "frame",
    }
)
_OVER_ARTICLES = frozenset({"the", "a", "an", "this", "that"})

# An explicit piece spec never splits: a prop list or a code fence means
# the editor already scoped one custom piece.
_EXPLICIT = re.compile(r"props\s*:|```", re.IGNORECASE)

_TOKEN = re.compile(r"[a-z]+")


class PiecePart(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1)
    route: Literal["native", "reuse", "new"]
    order: int = Field(ge=0)
    tool: str | None = None
    settings: dict[str, Any] = {}
    piece_id: str | None = Field(default=None, alias="pieceId")
    props: dict[str, Any] = {}
    brief: str = Field(min_length=1)
    note: str = ""


class PieceCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    native: int = 0
    reuse: int = 0
    new: int = 0


class PiecePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_version: Literal["0.1.0"] = Field(
        default="0.1.0", alias="schemaVersion"
    )
    brief: str = Field(min_length=1)
    parts: list[PiecePart] = Field(min_length=1)
    counts: PieceCounts


_STATUS_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "planned": 0,
    "native": 0,
    "reuse": 0,
    "new": 0,
    "adapted": 0,
    "guided": 0,
    "last_error": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: plans made, part routes, generation refusals."""
    with _STATUS_LOCK:
        return dict(_STATUS)


def reset_status() -> None:
    with _STATUS_LOCK:
        for key, value in list(_STATUS.items()):
            _STATUS[key] = 0 if isinstance(value, int) else None


def _note_plan(plan: PiecePlan) -> None:
    with _STATUS_LOCK:
        _STATUS["planned"] += 1
        _STATUS["native"] += plan.counts.native
        _STATUS["reuse"] += plan.counts.reuse
        _STATUS["new"] += plan.counts.new


def note_adapted() -> None:
    """A reuse part adapted its gold module into a piece."""
    with _STATUS_LOCK:
        _STATUS["adapted"] += 1


def note_guided() -> None:
    """An all-native plan answered with placement guidance, not a piece."""
    with _STATUS_LOCK:
        _STATUS["guided"] += 1


def _schema_path() -> Path:
    root = os.environ.get("CHAIR_ROOT", "").strip()
    if root:
        return Path(root) / "schemas" / "piece-plan.schema.json"
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "schemas" / "piece-plan.schema.json"
        if candidate.is_file():
            return candidate
    raise ValueError("schemas/piece-plan.schema.json not found")


def _validate_plan(data: dict[str, Any]) -> None:
    try:
        schema = json.loads(_schema_path().read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"cannot read piece-plan schema: {error}") from error
    errors = list(Draft202012Validator(schema).iter_errors(data))
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.absolute_path) or "plan"
        raise ValueError(f"invalid piece plan at {where}: {first.message}")


def _literal_spans(text: str) -> list[tuple[int, int]]:
    """Quoted and saying-phrase spans (rendered content, never split)."""
    spans: list[tuple[int, int]] = []
    for pattern in (_QUOTED, _LITERAL_AFTER):
        for match in pattern.finditer(text):
            spans.append(match.span(1))
    return spans


def _outside(spans: list[tuple[int, int]], at: int) -> bool:
    return all(at < start or at >= end for start, end in spans)


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def _content_tokens(text: str) -> list[str]:
    """Tokens minus literal spans (rendered content never blocks routing)."""
    spans = _literal_spans(text)
    if not spans:
        return _tokens(text)
    chars = list(text)
    for start, end in spans:
        for index in range(start, min(end, len(chars))):
            chars[index] = " "
    return _tokens("".join(chars))


def _has_native_noun(text: str) -> bool:
    return any(token in _NATIVE_NOUNS for token in _content_tokens(text))


def _cut_over(text: str) -> list[int]:
    """Cut offsets for layer "over" (time phrases like "over the duration" stay)."""
    spans = _literal_spans(text)
    cuts = []
    for match in _OVER_PATTERN.finditer(text):
        if not _outside(spans, match.start()):
            continue
        rest = _tokens(text[match.end():])
        if rest and rest[0] in _OVER_ARTICLES:
            rest = rest[1:]
        if rest and rest[0] in _OVER_TIME:
            continue
        cuts.append(match.start())
    return cuts


def _cut_with(text: str) -> list[int]:
    spans = _literal_spans(text)
    return [
        match.start()
        for match in _WITH_PATTERN.finditer(text)
        if _outside(spans, match.start())
    ]


def _cut_plus(text: str) -> list[int]:
    spans = _literal_spans(text)
    return [
        match.start()
        for match in _PLUS_PATTERN.finditer(text)
        if _outside(spans, match.start())
    ]


def _cut_and(text: str) -> list[int]:
    """Cut "and" only when both sides name a native tool ("grain and glow")."""
    spans = _literal_spans(text)
    cuts = []
    for match in _AND_PATTERN.finditer(text):
        if not _outside(spans, match.start()):
            continue
        if _has_native_noun(text[:match.start()]) and _has_native_noun(
            text[match.end():]
        ):
            cuts.append(match.start())
    return cuts


def _split_segment(text: str) -> list[str]:
    cuts: set[int] = set()
    for cutter in (_cut_over, _cut_plus, _cut_with):
        cuts.update(cutter(text))
    if not cuts:
        cuts.update(_cut_and(text))
    if not cuts:
        return [text]
    points = sorted(cuts)
    parts = [
        text[start:end]
        for start, end in zip([0, *points], [*points, len(text)], strict=True)
    ]
    out: list[str] = []
    for part in parts:
        cleaned = re.sub(
            r"^(?:over|plus|\+|with|and)\s+", "", part.strip(), flags=re.IGNORECASE
        ).strip(" ,;")
        if cleaned:
            out.append(re.sub(r"\s+", " ", cleaned))
    return out or [text]


def split_brief(brief: str) -> list[str]:
    """Split a loose ask into element parts. Explicit specs stay whole."""
    text = re.sub(r"\s+", " ", brief.strip())
    if not text:
        raise ValueError("plan needs a non-empty 'brief'")
    if _EXPLICIT.search(text):
        return [text]
    segments = [text]
    for _ in range(4):  # chains ("grain and glow over a gradient") need passes
        grown = [sub for segment in segments for sub in _split_segment(segment)]
        if grown == segments:
            return segments
        segments = grown
    return segments


def _native_allowed() -> bool:
    """Native routing needs new Fusion comp versions (the builder's path)."""
    try:
        return bool(resolve_manifest.MANIFEST.capabilities.fusion_comps)
    except Exception:
        return True


def _native_hit(text: str) -> tuple[str, dict[str, Any]] | None:
    """(tool, settings) when every content word is native-covered, else None."""
    tokens = _content_tokens(text)
    if not tokens or not any(token in _NATIVE_NOUNS for token in tokens):
        return None
    if any(token not in _COVERED for token in tokens):
        return None
    ranked = sorted(
        {token for token in tokens if token in _NATIVE_NOUNS},
        key=lambda token: (
            _TOOL_RANK.get(_NATIVE_NOUNS[token][0], 9),
            tokens.index(token),
        ),
    )
    tool, base = _NATIVE_NOUNS[ranked[0]]
    settings = dict(base)
    if tool == "Text+":
        literals = brief_literals(text)
        if literals:
            settings["text"] = literals[0]
    return tool, settings


def _stems(token: str) -> set[str]:
    out = {token}
    for suffix in ("ing", "ed", "es", "s"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 4:
            out.add(token[: -len(suffix)])
    return out


# Trigger words that name a gold module's subject. A part reuses an entry
# only when it says the subject out loud ("boxes" -> liquid-boxes, but a
# bare "liquid gradient" is mesh-gradient, not boxes). Entries added later
# without a row keep the old 2+ total-hits rule, so library additions stay
# data-only.
_REUSE_CORE: dict[str, frozenset[str]] = {
    "liquid-boxes": frozenset({"box", "boxes"}),
    "mesh-gradient": frozenset({"gradient", "gradients", "mesh"}),
    "dither-reveal": frozenset({"dither"}),
    "lower-third": frozenset({"lower"}),
    "physics-letters": frozenset(
        {"physics", "verlet", "rain", "raining", "tumble", "tumbling"}
    ),
    "morph-icon": frozenset({"morph", "morphing", "icon"}),
    "aurora-veil": frozenset({"aurora", "auroras"}),
    "glow-orb": frozenset({"glow", "glows", "glowing", "orb", "orbs"}),
}


def _reuse_match(text: str) -> dict[str, Any] | None:
    """Best gold library entry by subject word, ranked by total hits."""
    tokens = [token for token in _tokens(text) if len(token) > 2]
    if not tokens:
        return None
    stemmed = {bit for token in tokens for bit in _stems(token)}
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for index, entry in enumerate(skills.library_entries()):
        haystack = skills._entry_text(entry).lower()
        total = sum(
            1 for token in tokens if any(bit in haystack for bit in _stems(token))
        )
        core = _REUSE_CORE.get(str(entry.get("id")))
        if core is None:
            if total >= 2:
                scored.append((total, index, entry))
        elif stemmed & core:
            scored.append((total, index, entry))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[0][2]


def _short(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    return cleaned if len(cleaned) <= 48 else cleaned[:48].rstrip()


def _reuse_part(
    text: str, order: int, entry: dict[str, Any], note: str = ""
) -> PiecePart:
    return PiecePart(
        name=_short(text), route="reuse", order=order,
        piece_id=str(entry.get("id")), brief=text,
        note=((note + " ") if note else "")
        + f"Reuse {entry.get('id')}; adapt it with props.",
    )


def _route_part(text: str, order: int, native_ok: bool) -> PiecePart:
    note = ""
    hit = _native_hit(text)
    if hit is not None:
        if native_ok:
            tool, settings = hit
            return PiecePart(
                name=_short(text), route="native", order=order,
                tool=tool, settings=settings, brief=text,
            )
        note = (
            "Resolve cannot host this natively here "
            "(fusion comp versions are off); trying the library."
        )
    entry = _reuse_match(text)
    if entry is not None:
        return _reuse_part(text, order, entry, note)
    return PiecePart(
        name=_short(text), route="new", order=order, brief=text, note=note
    )


def plan_piece(brief: str) -> PiecePlan:
    """Split the brief and route each part. Deterministic: no model calls."""
    text = brief.strip()
    segments = split_brief(brief)
    native_ok = _native_allowed()
    if len(segments) == 1 and _EXPLICIT.search(text):
        # An explicit spec is already a custom-piece order: never reroute it.
        parts = [
            PiecePart(name=_short(text), route="new", order=0, brief=text)
        ]
    elif len(segments) == 1:
        # One loose element: reuse the library when it names the piece,
        # else it's new. Native routing applies to split-off layers, so a
        # lone ask always ends in a piece, never guidance alone.
        entry = _reuse_match(text)
        if entry is None:
            parts = [
                PiecePart(name=_short(text), route="new", order=0, brief=text)
            ]
        else:
            parts = [_reuse_part(text, 0, entry)]
    else:
        parts = [
            _route_part(segment, order, native_ok)
            for order, segment in enumerate(segments)
        ]
    counts = PieceCounts(
        native=sum(1 for part in parts if part.route == "native"),
        reuse=sum(1 for part in parts if part.route == "reuse"),
        new=sum(1 for part in parts if part.route == "new"),
    )
    plan = PiecePlan(brief=text, parts=parts, counts=counts)
    _validate_plan(plan.model_dump(mode="json", by_alias=True))
    _note_plan(plan)
    return plan


def brief_literals(brief: str) -> list[str]:
    """Quoted and saying-phrase values, in position order, deduplicated."""
    spans = _literal_spans(brief)
    seen: list[str] = []
    for start, end in sorted(spans):
        candidate = brief[start:end].strip()
        trimmed = _HEX_TAIL.sub("", candidate)
        if trimmed != candidate:  # "HELLO in #FF0000" keeps HELLO for text
            trimmed = _HEX_PREP.sub("", trimmed).strip()
            candidate = trimmed
        if candidate and candidate not in seen:
            seen.append(candidate)
    return seen


def guidance(plan: PiecePlan, adapted_id: str | None = None) -> str:
    """Plain placement notes for parts no piece covers. Never an error."""
    lines: list[str] = []
    for part in plan.parts:
        if part.route == "native" and part.tool:
            literal = part.settings.get("text", "")
            literal = literal.strip() if isinstance(literal, str) else ""
            if part.tool == "Text+" and literal:
                lines.append(f"Add Text+ {literal!r} in Resolve")
            else:
                lines.append(f"Add {part.tool} in Resolve for {part.brief!r}")
        elif part.route == "reuse" and part.piece_id != adapted_id:
            lines.append(f"Also reuse {part.piece_id} for {part.brief!r}")
    return "; ".join(lines)
