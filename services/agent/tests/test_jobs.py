import json
import threading
from datetime import UTC, datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent.__main__ import Handler
from chair_agent.jobs import (
    HandlerResult,
    Job,
    JobConflict,
    JobController,
    JobInvalid,
    JobNotFound,
    WebhookVerifyError,
    poll_delay_seconds,
    run_worker,
    verify_delivery,
)


def _controller(tmp_path: Path, **kwargs) -> JobController:
    kwargs.setdefault("deliver", lambda url, body, headers: None)
    return JobController(tmp_path / "jobs.json", **kwargs)


def test_submit_returns_queued_handle(tmp_path: Path) -> None:
    job = _controller(tmp_path).submit("transcribe", {"media": "a.mov"})

    assert job.status == "queued"
    assert job.request_id
    assert job.task == "transcribe"
    assert job.expires_at is None
    assert job.billable is None


def test_happy_path_runs_to_completed(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    job = controller.submit("transcribe")

    claimed = controller.claim_next()
    assert claimed is not None and claimed.request_id == job.request_id
    assert claimed.status == "in_progress"

    done = controller.finish_completed(
        job.request_id,
        artifacts=[{"url": "https://cdn.example.test/t.srt", "content_type": "text/vtt"}],
        ops=[{"op": "add_track", "kind": "captions"}],
    )
    assert done.status == "completed"
    assert done.billable is True
    assert done.artifacts[0].url.endswith("t.srt")
    assert done.expires_at is not None
    assert done.changeset is not None and done.changeset.status == "proposed"
    assert controller.claim_next() is None


def test_cancel_only_while_queued(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    queued = controller.submit("transcribe")
    canceled = controller.cancel(queued.request_id)
    assert canceled.status == "canceled"
    assert canceled.billable is False

    running = controller.submit("transcribe")
    controller.claim_next()
    with pytest.raises(JobConflict):
        controller.cancel(running.request_id)
    with pytest.raises(JobConflict):
        controller.cancel(queued.request_id)
    assert controller.get(running.request_id).status == "in_progress"


def test_failed_and_moderated_are_terminal_and_not_billable(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    failed_id = controller.submit("transcribe").request_id
    controller.claim_next()
    failed = controller.finish_failed(failed_id, "no speech found")
    assert failed.status == "failed"
    assert failed.error == "no speech found"
    assert failed.billable is False

    moderated_id = controller.submit("generate_image").request_id
    controller.claim_next()
    moderated = controller.finish_moderated(moderated_id, "blocked prompt")
    assert moderated.status == "moderated"
    assert moderated.billable is False


def test_idempotent_submit_replays_same_request(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    first = controller.submit("transcribe", {"media": "a.mov"}, idempotency_key="key-1")
    replay = controller.submit("transcribe", {"media": "a.mov"}, idempotency_key="key-1")
    assert replay.request_id == first.request_id

    with pytest.raises(JobConflict):
        controller.submit("sam3_mask", {"media": "a.mov"}, idempotency_key="key-1")


def test_state_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "jobs.json"
    first_id = _controller(tmp_path).submit("transcribe", idempotency_key="key-1").request_id

    restarted = JobController(path, deliver=lambda url, body, headers: None)
    assert restarted.get(first_id).status == "queued"
    replay = restarted.submit("transcribe", idempotency_key="key-1")
    assert replay.request_id == first_id


def test_terminal_transition_delivers_signed_webhook(tmp_path: Path) -> None:
    seen: dict = {}

    def deliver(url: str, body: bytes, headers: dict[str, str]) -> None:
        seen.update(url=url, body=body, headers=headers)

    controller = _controller(
        tmp_path, deliver=deliver, webhook_secret="whsec_dGVzdC1zZWNyZXQ="
    )
    job = controller.submit("transcribe", webhook_url="https://example.test/hook")
    controller.claim_next()
    controller.finish_completed(job.request_id)

    assert seen["url"] == "https://example.test/hook"
    payload = json.loads(seen["body"])
    assert payload["request_id"] == job.request_id
    assert payload["status"] == "completed"
    assert payload["expires_at"]
    verify_delivery("whsec_dGVzdC1zZWNyZXQ=", seen["headers"], seen["body"])

    with pytest.raises(WebhookVerifyError):
        verify_delivery("whsec_dGVzdC1zZWNyZXQ=", seen["headers"], b'{"tampered":true}')


def test_verify_rejects_stale_timestamp() -> None:
    from chair_agent.jobs import sign_delivery

    body = b'{"request_id":"r","status":"completed"}'
    headers = sign_delivery("whsec_dGVzdC1zZWNyZXQ=", body, timestamp=1)
    with pytest.raises(WebhookVerifyError):
        verify_delivery("whsec_dGVzdC1zZWNyZXQ=", headers, body)


def test_poll_backoff_rises_then_caps() -> None:
    delays = [poll_delay_seconds(attempt) for attempt in range(6)]
    assert delays[0] == 2.0
    assert delays == sorted(delays)
    assert delays[-1] == 10.0


def test_artifacts_expire_after_seven_days(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    job = controller.submit("transcribe")
    controller.claim_next()
    finished = datetime.now(UTC)
    done = controller.finish_completed(job.request_id, artifacts=[{"url": "https://x/y"}])
    assert done.expires_at is not None
    assert timedelta(days=6, hours=23) < done.expires_at - finished < timedelta(days=7, hours=1)

    pruned = controller.prune_expired(now=done.expires_at + timedelta(seconds=1))
    assert pruned == 1
    expired = controller.get(job.request_id)
    assert expired.artifacts == []
    assert expired.expired is True
    assert expired.status == "completed"


def test_worker_runs_jobs_to_terminal(tmp_path: Path) -> None:
    controller = _controller(tmp_path)

    def transcribe(job: Job) -> HandlerResult:
        assert job.input["media"] == "a.mov"
        return HandlerResult(artifacts=[{"url": "https://x/t.srt"}], ops=[{"op": "add_track"}])

    known = controller.submit("transcribe", {"media": "a.mov"})
    unknown = controller.submit("nope")
    stop = threading.Event()
    thread = threading.Thread(
        target=run_worker, args=(controller, {"transcribe": transcribe}), kwargs={"stop": stop}
    )
    thread.start()
    try:
        for _ in range(200):
            known_done = controller.get(known.request_id).status == "completed"
            unknown_done = controller.get(unknown.request_id).status in {
                "completed",
                "failed",
                "moderated",
                "canceled",
            }
            if known_done and unknown_done:
                break
            stop.wait(0.05)
    finally:
        stop.set()
        thread.join(timeout=5)

    done = controller.get(known.request_id)
    assert done.status == "completed"
    assert done.changeset is not None and done.changeset.status == "proposed"
    assert controller.get(unknown.request_id).status == "failed"


def test_unknown_job_raises_not_found(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    with pytest.raises(JobNotFound):
        controller.get("req_missing")
    with pytest.raises(JobNotFound):
        controller.cancel("req_missing")


def _serve(handler_controller: JobController) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    Handler.controller = handler_controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_address[1]}"


def _post(base: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    request = Request(
        base + path,
        data=json.dumps(body or {}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except Exception as error:  # urllib raises HTTPError with a readable body
        return error.code, json.load(error)


def test_http_submit_status_and_cancel(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    server, thread, base = _serve(controller)
    try:
        status, submitted = _post(base, "/jobs", {"task": "transcribe"})
        assert status == 200
        assert submitted["status"] == "queued"
        request_id = submitted["request_id"]
        assert submitted["status_url"].endswith(f"/jobs/{request_id}")
        assert submitted["cancel_url"].endswith(f"/jobs/{request_id}/cancel")

        with urlopen(f"{base}/jobs/{request_id}") as response:
            polled = json.load(response)
        assert polled["request_id"] == request_id
        assert polled["status"] == "queued"

        status, canceled = _post(base, f"/jobs/{request_id}/cancel")
        assert status == 200
        assert canceled["status"] == "canceled"

        status, conflict = _post(base, f"/jobs/{request_id}/cancel")
        assert status == 409
        assert conflict["error"]["code"] == "job_not_cancellable"

        status, missing = _post(base, "/jobs/req_missing/cancel")
        assert status == 404
        assert missing["error"]["code"] == "job_not_found"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_restart_requeues_in_progress_jobs(tmp_path: Path) -> None:
    path = tmp_path / "jobs.json"
    controller = JobController(path, deliver=lambda url, body, headers: None)
    job = controller.submit("transcribe")
    controller.claim_next()
    assert controller.get(job.request_id).status == "in_progress"

    restarted = JobController(path, deliver=lambda url, body, headers: None)
    recovered = restarted.get(job.request_id)
    assert recovered.status == "queued"
    assert recovered.started_at is None
    assert restarted.claim_next() is not None


def test_http_rejects_non_string_webhook_url(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    server, thread, base = _serve(controller)
    try:
        status, body = _post(base, "/jobs", {"task": "transcribe", "webhook_url": 123})
        assert status == 400
        assert body["error"]["code"] == "invalid_webhook_url"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_worker_survives_bad_handler_result(tmp_path: Path) -> None:
    controller = _controller(tmp_path)

    def bad(job: Job) -> HandlerResult:
        return HandlerResult(artifacts=[{"url": "https://x/f", "bogus": 1}], ops=[])

    def good(job: Job) -> HandlerResult:
        return HandlerResult(artifacts=[{"url": "https://x/g"}], ops=[])

    bad_id = controller.submit("bad").request_id
    good_id = controller.submit("good").request_id
    stop = threading.Event()
    thread = threading.Thread(
        target=run_worker, args=(controller, {"bad": bad, "good": good}), kwargs={"stop": stop}
    )
    thread.start()
    try:
        for _ in range(200):
            if controller.get(good_id).status == "completed":
                break
            stop.wait(0.05)
    finally:
        stop.set()
        thread.join(timeout=5)

    failed = controller.get(bad_id)
    assert failed.status == "failed"
    assert "ValidationError" in (failed.error or "")
    assert controller.get(good_id).status == "completed"
    reloaded = JobController(tmp_path / "jobs.json", deliver=lambda url, body, headers: None)
    assert reloaded.get(bad_id).status == "failed"


def test_worker_survives_malformed_webhook_secret(tmp_path: Path) -> None:
    controller = _controller(tmp_path, webhook_secret="not-valid-base64!!")

    def ok(job: Job) -> HandlerResult:
        return HandlerResult()

    first = controller.submit("ok", webhook_url="https://example.test/hook")
    second = controller.submit("ok", webhook_url="https://example.test/hook")
    stop = threading.Event()
    thread = threading.Thread(
        target=run_worker, args=(controller, {"ok": ok}), kwargs={"stop": stop}
    )
    thread.start()
    try:
        for _ in range(200):
            if controller.get(second.request_id).status == "completed":
                break
            stop.wait(0.05)
    finally:
        stop.set()
        thread.join(timeout=5)

    assert controller.get(first.request_id).status == "completed"
    assert controller.get(first.request_id).webhook_delivered is False
    assert controller.get(second.request_id).status == "completed"


def test_submit_rejects_webhook_url_without_secret(tmp_path: Path) -> None:
    controller = _controller(tmp_path)
    with pytest.raises(JobInvalid) as excinfo:
        controller.submit("transcribe", webhook_url="https://example.test/hook")
    assert excinfo.value.code == "webhook_requires_secret"
