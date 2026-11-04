"""Cut-write counters for the agent health endpoint (#293).

Every /cuts/apply and /cuts/undo notes here, so a land can be checked
without reading code: cuts landed, undone, skipped ops, last error, and
last write milliseconds.
"""

import threading
from typing import Any

_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "landed": 0,
    "undone": 0,
    "skipped_ops": 0,
    "last_error": None,
    "last_write_ms": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: cut writes landed/undone, skipped ops, error, ms."""
    with _LOCK:
        return dict(_STATUS)


def note_applied(
    *, skipped_ops: int, write_ms: float, error: str | None = None
) -> None:
    """Note one /cuts/apply: counts the land, or records the failure."""
    with _LOCK:
        if error is None:
            _STATUS["landed"] += 1
            _STATUS["skipped_ops"] += skipped_ops
        _STATUS["last_write_ms"] = write_ms
        _STATUS["last_error"] = error


def note_undone(*, error: str | None = None) -> None:
    """Note one /cuts/undo: counts the undo, or records the failure."""
    with _LOCK:
        if error is None:
            _STATUS["undone"] += 1
        _STATUS["last_error"] = error
