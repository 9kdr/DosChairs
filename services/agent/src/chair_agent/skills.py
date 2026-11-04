"""Skills for the effect-module pipeline (issue #259).

Progressive disclosure, three levels:

- L1 (orchestrator): ``descriptions()`` — one line per skill.
- L2 (authoring subagent): ``skill_text()`` — the full SKILL.md plus taste.
- L3 (retrieval): ``context_for()`` — L2 plus the top-3 library entries and
  the top-2 gold examples by keyword score, capped at 6000 chars.

The library index is canonical in ``packages/effects/library/index.json``
(bundled offline); ``services/agent/skills/library/index.json`` is the same
file, and a test keeps the two identical.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_CONTEXT_CHARS = 6000
WONDER_CONTEXT_CHARS = 3500
TOP_LIBRARY = 3
TOP_EXAMPLES = 2

WONDER_NOTE = (
    "Toolbox, optional: the library below is inspiration, not a base. "
    "You may write entirely your own code — custom shaders, your own "
    "physics or logic, or nothing from the library at all. You still must "
    "pass the same contract: a pure function of (props, history, t), "
    "seekable through the SeekAdapter, deterministic in any order, props "
    "keyframable, and licence-safe (no copied or paid-company code). "
    "Render only the element asked for on a transparent background, no "
    "text unless asked, no decorative extras; honor the kit's transparentBg "
    "switch (it paints the backing fill) and paint no fill of your own."
)


def skills_root() -> Path:
    return Path(__file__).resolve().parents[2] / "skills"


def repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages" / "effects" / "approved-imports.json").is_file():
            return parent
    return skills_root().parents[1]


def _frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    fields: dict[str, str] = {}
    for line in text[3:end].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return fields


def _skill_ids(root: Path | None = None) -> list[str]:
    base = root or skills_root()
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def _read_skill_doc(skill: str, root: Path | None = None) -> str:
    base = root or skills_root()
    doc = (base / skill / "SKILL.md").read_text(encoding="utf-8")
    taste = base / "taste.md"
    if taste.is_file():
        doc += "\n\n" + taste.read_text(encoding="utf-8")
    return doc


def descriptions(root: Path | None = None) -> str:
    """L1: one `id: description` line per skill, for the orchestrator."""
    lines = []
    for skill in _skill_ids(root):
        fields = _frontmatter((root or skills_root()) / skill / "SKILL.md")
        lines.append(f"{skill}: {fields.get('description', skill)}")
    return "\n".join(lines)


def skill_text(skill: str, root: Path | None = None) -> str:
    """L2: the full SKILL.md plus the house taste, for the authoring call."""
    return _read_skill_doc(skill, root)


def library_entries() -> list[dict[str, Any]]:
    """Gold library rows from the canonical bundled index."""
    for candidate in (
        skills_root() / "library" / "index.json",
        repo_root() / "packages" / "effects" / "library" / "index.json",
    ):
        if candidate.is_file():
            return list(json.loads(candidate.read_text(encoding="utf-8")).get("entries", []))
    return []


def example_notes(root: Path | None = None) -> list[dict[str, str]]:
    """One row per gold-example note across all skills."""
    base = root or skills_root()
    notes = []
    for skill in _skill_ids(base):
        folder = base / skill / "examples"
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md")):
            notes.append(
                {"skill": skill, "name": path.stem, "text": path.read_text(encoding="utf-8")}
            )
    return notes


def _score(text: str, tokens: list[str]) -> int:
    lowered = text.lower()
    return sum(1 for token in tokens if token in lowered)


def _tokens(brief: str) -> list[str]:
    return [token for token in brief.lower().split() if len(token) > 2]


def _entry_text(entry: dict[str, Any]) -> str:
    props = ", ".join(f"{p['id']} ({p['type']})" for p in entry.get("props", []))
    libs = ", ".join(f"{lib['name']} ({lib['license']})" for lib in entry.get("libraries", []))
    return (
        f"[{entry.get('id')}] {entry.get('summary', '')} "
        f"Tags: {', '.join(entry.get('tags', []))}. "
        f"Adapter: {entry.get('source', '')} ({libs}). Controls: {props}."
    )


def _entry_row(entry: dict[str, Any]) -> str:
    """Compact library row for the prompt; scoring still uses the full text."""
    source = entry.get("source", "")
    summary = entry.get("summary", "")
    props = ", ".join(p["id"] for p in entry.get("props", []))
    return f"[{entry.get('id')}] ({source}) {summary} Props: {props}."


def context_for(
    brief: str,
    skills: tuple[str, ...] = ("effects", "motion"),
    max_chars: int = MAX_CONTEXT_CHARS,
    root: Path | None = None,
) -> str:
    """L3: taste once, skill docs, closest library entries, gold examples; capped."""
    base = root or skills_root()
    parts: list[str] = []
    taste = base / "taste.md"
    if taste.is_file():
        parts.append(taste.read_text(encoding="utf-8"))
    for skill in skills:
        doc = base / skill / "SKILL.md"
        if doc.is_file():
            parts.append(doc.read_text(encoding="utf-8"))
    tokens = _tokens(brief or "")
    if tokens:
        ranked = sorted(
            ((_score(_entry_text(e), tokens), e) for e in library_entries()),
            key=lambda item: -item[0],
        )
        for _, entry in ranked[:TOP_LIBRARY]:
            parts.append(_entry_row(entry))
        notes = sorted(
            ((_score(f"{n['name']} {n['text']}", tokens), n) for n in example_notes(root)),
            key=lambda item: -item[0],
        )
        for _, note in notes[:TOP_EXAMPLES]:
            label = f"Gold example ({note['skill']}/{note['name']}):"
            parts.append(f"{label} {note['text'].strip()[:800]}")
    else:
        for entry in library_entries()[:TOP_LIBRARY]:
            parts.append(_entry_text(entry))
    return _capped(parts, max_chars)


def wonder_context(
    max_chars: int = WONDER_CONTEXT_CHARS,
    root: Path | None = None,
) -> str:
    """L3 for Wonder: taste plus the whole library as one-line toolbox rows."""
    base = root or skills_root()
    parts = [WONDER_NOTE]
    taste = base / "taste.md"
    if taste.is_file():
        parts.append(taste.read_text(encoding="utf-8"))
    for entry in library_entries():
        props = ", ".join(p["id"] for p in entry.get("props", []))
        parts.append(f"[{entry.get('id')}] {entry.get('summary', '')} Controls: {props}.")
    return _capped(parts, max_chars)


def _capped(parts: list[str], max_chars: int) -> str:
    out: list[str] = []
    used = 0
    for part in parts:
        if used + len(part) + 2 > max_chars:
            break
        out.append(part)
        used += len(part) + 2
    return "\n\n".join(out)
