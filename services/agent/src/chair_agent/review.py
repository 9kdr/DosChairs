"""Project review bundle: live timeline mirror plus latest pending proposal.

GET /projects/:id/review serves this bundle so the desktop review board
loads both through the service link with no sample data. The mirror is a
read-only pass-through of the timeline open in Resolve Studio; a stored
proposal never changes it.
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from chair_agent.jobs import JobController
from chair_agent.projects import FILE_SUFFIXES, detect_projects, find_project_file


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


def read_kdenlive_timeline(file_path: Path) -> dict[str, Any]:
    """Read a Kdenlive project from disk into a timeline."""
    try:
        from chair_kdenlive import timeline_from_kdenlive
    except ImportError as error:
        raise ReviewUnavailable(
            "kdenlive_adapter_missing",
            "the Kdenlive read adapter is not installed",
        ) from error
    try:
        return timeline_from_kdenlive(str(file_path))
    except (ValueError, OSError) as error:
        raise ReviewUnavailable("invalid_project", str(error)) from error


def read_project_timeline(project_id: str | None = None) -> dict[str, Any]:
    """Read timeline for a project, preferring Resolve when open, or file-based project."""
    if project_id:
        editor, sep, slug = project_id.partition(":")
        if sep and editor == "resolve":
            return read_resolve_timeline()
        if sep and editor == "kdenlive":
            file_path = find_project_file(slug, "kdenlive")
            if file_path is None:
                raise ReviewUnavailable(
                    "project_not_found", f"Kdenlive project {slug!r} not found on disk"
                )
            return read_kdenlive_timeline(file_path)
        if sep and editor == "otio":
            file_path = find_project_file(slug, "otio")
            if file_path is None:
                raise ReviewUnavailable(
                    "project_not_found", f"OTIO project {slug!r} not found on disk"
                )
            try:
                import chair_otio

                reader = getattr(chair_otio, "timeline_from_otio", None)
                if reader is not None:
                    return reader(str(file_path))
            except ImportError:
                pass
            raise ReviewUnavailable(
                "otio_read_unsupported",
                "the OTIO read adapter is not implemented",
            )
        try:
            return read_resolve_timeline()
        except ReviewUnavailable:
            file_path = find_project_file(project_id)
            if file_path is not None:
                if file_path.suffix.casefold() in FILE_SUFFIXES["kdenlive"]:
                    return read_kdenlive_timeline(file_path)
            raise

    try:
        return read_resolve_timeline()
    except ReviewUnavailable:
        found = detect_projects()
        file_projects = [
            p for p in found.get("projects", []) if p.get("editor") in ("kdenlive", "otio")
        ]
        if file_projects:
            first_id = file_projects[0]["id"]
            return read_project_timeline(first_id)
        raise


ReadTimeline = Callable[[], dict[str, Any]]


def build_review(
    controller: JobController,
    project_id: str,
    *,
    read_timeline: ReadTimeline | None = None,
) -> dict[str, Any]:
    """Bundle the live mirror with the latest pending proposal for the project."""
    timeline = read_timeline() if read_timeline is not None else read_project_timeline(project_id)
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
