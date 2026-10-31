"""First verifier: accepts or rejects a preview before the UI shows it.

v1 checks the mechanical facts: the changeset is valid and pending-only,
a preview exists, and every cut fits inside the proxy. Issue #16 hardens
this gate later with content checks; that work is out of scope here.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from chair_agent.edit_ops import InvalidChangeset, validate_changeset


class Verdict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    accepted: bool
    reasons: list[str]


def verify(
    changeset_data: Mapping[str, Any],
    *,
    artifact_urls: Sequence[str],
    total_frames: int,
) -> Verdict:
    """Accept or reject a preview. Rejections carry reasons; accepts don't."""
    reasons: list[str] = []
    try:
        changeset = validate_changeset(changeset_data)
    except InvalidChangeset as error:
        return Verdict(accepted=False, reasons=[f"invalid changeset: {error}"])
    if not changeset.items:
        reasons.append("changeset has no items")
    for item in changeset.items:
        if item.status != "pending":
            reasons.append(f"item {item.id} is {item.status}, not pending")
    if not list(artifact_urls):
        reasons.append("no preview rendered")
    ranges: list[tuple[str, int, int]] = []
    for item in changeset.items:
        patch = item.patch or {}
        if item.op == "remove_clip":
            start = patch.get("startFrames", 0)
            frames = patch.get("frames", 0)
            if not isinstance(start, int) or not isinstance(frames, int):
                reasons.append(f"item {item.id} has a non-integer cut range")
                continue
            if start < 0 or frames <= 0 or start + frames > total_frames:
                reasons.append(f"item {item.id} cuts outside the proxy")
            else:
                ranges.append((item.id, start, start + frames))
    ordered = sorted(ranges, key=lambda entry: entry[1])
    for first, second in zip(ordered, ordered[1:], strict=False):
        if second[1] < first[2]:
            reasons.append(f"items {first[0]} and {second[0]} cut overlapping frames")
    cut_frames = sum(end - start for _, start, end in ranges)
    if ranges and cut_frames >= total_frames:
        reasons.append("cuts remove the whole proxy")
    return Verdict(accepted=not reasons, reasons=reasons)
