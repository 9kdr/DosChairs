import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest
from chair_agent.__main__ import Handler
from chair_agent.jobs import Job, JobController
from chair_agent.review import ReviewUnavailable, build_review

MIRROR = {
    "schemaVersion": "0.1.0",
    "id": "timeline-9",
    "name": "Rough cut",
    "rate": {"num": 24, "den": 1},
    "tracks": [],
    "markers": [],
}


def _controller(tmp_path: Path) -> JobController:
    return JobController(tmp_path / "jobs.json", deliver=lambda url, body, headers: None)


def _completed(
    controller: JobController, task: str, input: dict[str, Any], ops: list[dict[str, Any]]
) -> Job:
    job = controller.submit(task, input)
    controller.claim_next()
    return controller.finish_completed(job.request_id, ops=ops)


def test_review_returns_mirror_and_latest_proposal(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    _completed(controller, "edit", {"project_id": "proj_1"}, ops=[{"op": "cut", "id": "old"}])
    wanted = _completed(
        controller, "edit", {"target_id": "timeline-9"}, ops=[{"op": "cut", "id": "new"}]
    )

    body = build_review(controller, "proj_1", read_timeline=lambda: MIRROR)

    assert body["project_id"] == "proj_1"
    assert body["timeline"] == MIRROR
    assert body["changeset"] == {"status": "proposed", "ops": [{"op": "cut", "id": "new"}]}
    assert body["job"]["request_id"] == wanted.request_id
    assert body["job"]["task"] == "edit"
    assert body["job"]["finished_at"] == wanted.finished_at


def test_review_skips_unfinished_unlinked_and_shapeless_jobs(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    _completed(controller, "edit", {"project_id": "proj_other"}, ops=[{"op": "cut"}])
    _completed(controller, "edit", {"target_id": {"nested": "dict"}}, ops=[{"op": "cut"}])
    without_ops = controller.submit("transcribe", {"project_id": "proj_1"})
    controller.claim_next()
    controller.finish_completed(without_ops.request_id)
    controller.submit("edit", {"project_id": "proj_1"})

    body = build_review(controller, "proj_1", read_timeline=lambda: MIRROR)

    assert body["timeline"] == MIRROR
    assert body["changeset"] is None
    assert body["job"] is None


def test_review_without_studio_fails_clearly(tmp_path: Path) -> None:
    def closed() -> dict[str, Any]:
        raise ReviewUnavailable("resolve_unavailable", "DaVinci Resolve Studio is closed.")

    with pytest.raises(ReviewUnavailable, match="Studio is closed"):
        build_review(_controller(tmp_path), "proj_1", read_timeline=closed)


def _serve(controller: JobController) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def test_http_review_endpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(tmp_path)
    job = _completed(
        controller, "transcribe", {"target_id": "Rough cut"}, ops=[{"op": "add_track"}]
    )
    monkeypatch.setattr("chair_agent.review.read_resolve_timeline", lambda: MIRROR)
    server, thread, base = _serve(controller)
    try:
        with urlopen(f"{base}/projects/proj_1/review") as response:
            assert response.status == 200
            body = json.load(response)
        assert body["project_id"] == "proj_1"
        assert body["timeline"]["id"] == "timeline-9"
        assert body["changeset"]["ops"] == [{"op": "add_track"}]
        assert body["job"]["request_id"] == job.request_id

        with pytest.raises(HTTPError) as missing:
            urlopen(f"{base}/projects/proj_1/timeline")
        assert missing.value.code == 404
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_http_review_without_studio_returns_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def closed() -> dict[str, Any]:
        raise ReviewUnavailable(
            "resolve_unavailable", "DaVinci Resolve Studio is closed. Open it and try again."
        )

    monkeypatch.setattr("chair_agent.review.read_resolve_timeline", closed)
    server, thread, base = _serve(_controller(tmp_path))
    try:
        with pytest.raises(HTTPError) as error:
            urlopen(f"{base}/projects/proj_1/review")
        assert error.value.code == 503
        payload = json.load(error.value)
        assert payload["error"]["code"] == "resolve_unavailable"
        assert "Resolve Studio is closed" in payload["error"]["message"]
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
