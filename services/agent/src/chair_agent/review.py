"""Project review bundle: live timeline mirror plus latest pending proposal.

GET /projects/:id/review serves this bundle so the desktop review board
loads both through the service link with no sample data. The mirror is a
read-only pass-through of the timeline open in Resolve Studio; a stored
proposal never changes it.
"""

from collections.abc import Callable
from typing import Any

from chair_agent.jobs import JobController


class ReviewUnavailable(Exception):
    """The mirror cannot be read right now (e.g. Studio is closed)."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def read_resolve_timeline() -> dict[str, Any]:
    """Read the timeline open in Resolve Studio; fail clearly without it."""
    try:
        from chair_resolve.read import ResolveClosedError, read_current_timeline
    except ImportError as error:
        raise ReviewUnavailable(
            "resolve_adapter_missing",
            "the Resolve read adapter is not installed",
        ) from error
    try:
        return read_current_timeline()
    except ResolveClosedError as error:
        raise ReviewUnavailable("resolve_unavailable", str(error)) from error


ReadTimeline = Callable[[], dict[str, Any]]


def build_review(
    controller: JobController,
    project_id: str,
    *,
    read_timeline: ReadTimeline | None = None,
) -> dict[str, Any]:
    """Bundle the live mirror with the latest pending proposal for the project."""
    timeline = (read_timeline or read_resolve_timeline)()
    job = controller.latest_proposal(project_id, timeline)
    return {
        "project_id": project_id,
        "timeline": timeline,
        "changeset": job.changeset.model_dump(mode="json") if job is not None else None,
        "job": (
            {
                "request_id": job.request_id,
                "task": job.task,
                "finished_at": job.finished_at,
            }
            if job is not None
            else None
        ),
    }
