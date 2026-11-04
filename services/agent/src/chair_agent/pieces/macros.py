"""Resolve macros as pieces (issue #242).

The Resolve adapter scans the editor's own Fusion macros, templates, OGraf
titles and .drfx packs, read-only. This module caches that scan, merges it
with the built-in piece catalogue into one list of pieces with controls, and
turns the pieces an editor referenced in a brief into a prompt note so the
model reuses or wraps them instead of reinventing them.
"""

import threading
from collections import Counter
from collections.abc import Sequence
from typing import Any

from chair_resolve import ScanResult, scan_fusion

from chair_agent.pieces.catalog import PIECES

_LOCK = threading.Lock()
_SCAN: ScanResult | None = None
_LAST_ERROR: str | None = None

MAX_REFERENCES = 12


def get_scan(*, rescan: bool = False) -> ScanResult:
    """Cached scan; the first call (or rescan=True) reads the Fusion folders."""
    global _SCAN, _LAST_ERROR
    with _LOCK:
        if _SCAN is None or rescan:
            try:
                _SCAN = scan_fusion()
                _LAST_ERROR = _SCAN.errors[-1] if _SCAN.errors else None
            except Exception as error:  # a broken folder must not take the agent down
                _LAST_ERROR = str(error) or error.__class__.__name__
                if _SCAN is None:
                    _SCAN = ScanResult(pieces=[], errors=[_LAST_ERROR], roots=[], scanned_at="")
        return _SCAN


def status_snapshot() -> dict[str, Any]:
    """Health: macro counts by kind, last scan time, last error. Never scans."""
    with _LOCK:
        scan, error = _SCAN, _LAST_ERROR
    counts = Counter(piece.kind for piece in scan.pieces) if scan else Counter()
    return {
        "counts": dict(sorted(counts.items())),
        "total": sum(counts.values()),
        "catalog": len(PIECES),
        "roots": scan.roots if scan else [],
        "skipped_files": len(scan.errors) if scan else 0,
        "last_scan_at": (scan.scanned_at or None) if scan else None,
        "last_error": error,
    }


def _catalog_entries() -> list[dict[str, Any]]:
    return [
        {
            "id": piece.id,
            "name": piece.title,
            "kind": piece.effect,
            "origin": "catalog",
            "source": "catalog",
            "summary": piece.summary,
            "controls": [
                {
                    "key": name,
                    "name": name,
                    "type": "choice",
                    "default": spec.default,
                    "choices": list(spec.values),
                }
                for name, spec in piece.enums.items()
            ],
        }
        for piece in PIECES
    ]


def _macro_entries(scan: ScanResult) -> list[dict[str, Any]]:
    entries = []
    for piece in scan.pieces:
        controls = [c.model_dump(mode="json", exclude_none=True) for c in piece.controls]
        where = f"in {piece.pack}" if piece.pack else f"in the {piece.source} Fusion folder"
        entries.append(
            {
                "id": piece.id,
                "name": piece.name,
                "kind": piece.kind,
                "origin": "macro",
                "source": piece.source,
                "summary": f"Resolve {piece.kind} {where}, {len(controls)} published controls.",
                "controls": controls,
                "path": piece.path,
                **({"pack": piece.pack} if piece.pack else {}),
            }
        )
    return entries


def _score(entry: dict[str, Any], tokens: Sequence[str]) -> int:
    name = entry["name"].lower()
    rest = " ".join(
        [entry["kind"], entry["summary"], *(control["name"] for control in entry["controls"])]
    ).lower()
    return sum(3 if token in name else 1 if token in rest else 0 for token in tokens)


def list_pieces(query: str = "", *, limit: int = 50, rescan: bool = False) -> dict[str, Any]:
    """Catalogue pieces and Resolve macros together, filtered and ranked by query."""
    entries = _catalog_entries() + _macro_entries(get_scan(rescan=rescan))
    tokens = [token for token in query.lower().split() if token]
    # The editor's own macros first, then the built-in catalogue, then Resolve's stock set.
    order = {"user": 0, "catalog": 1, "system": 2}
    scored = sorted(
        ((entry, _score(entry, tokens)) for entry in entries),
        key=lambda item: (-item[1], order[item[0]["source"]]),
    )
    entries = [entry for entry, score in scored if score > 0 or not tokens]
    return {"pieces": entries[: max(1, limit)], "total": len(entries)}


def find_piece(piece_id: str) -> dict[str, Any] | None:
    for entry in _catalog_entries() + _macro_entries(get_scan()):
        if entry["id"] == piece_id:
            return entry
    return None


def _describe(control: dict[str, Any]) -> str:
    text = f"{control['name']} ({control['type']}"
    if control.get("default") is not None:
        text += f", default {control['default']}"
    if control.get("min") is not None or control.get("max") is not None:
        text += f", range {control.get('min', '…')} to {control.get('max', '…')}"
    if control.get("choices"):
        text += f", one of {', '.join(control['choices'])}"
    return text + ")"


def references_note(references: Any) -> str:
    """Prompt text for the pieces the editor @-mentioned; unknown ids are named, not hidden."""
    if not isinstance(references, list):
        return ""
    lines = []
    for ref in references[:MAX_REFERENCES]:
        if not isinstance(ref, dict) or not isinstance(ref.get("id"), str):
            continue
        piece = find_piece(ref["id"])
        label = str(ref.get("label") or ref["id"])[:80]
        if piece is None:
            lines.append(f"- @{label}: no longer in the library; ask what it should look like.")
            continue
        controls = "; ".join(_describe(c) for c in piece["controls"][:12])
        controls = controls or "no published controls"
        lines.append(f"- @{piece['name']} ({piece['kind']}, {piece['source']}): {controls}.")
    if not lines:
        return ""
    return (
        "The editor referenced these pieces from their own library. Reuse or wrap them "
        "(keep their control names so the editor's settings still map) instead of "
        "redrawing the same look:\n" + "\n".join(lines)
    )
