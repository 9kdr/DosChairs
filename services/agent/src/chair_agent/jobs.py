"""Async job controller: one request handle per agent task.

Mirrors the Higgsfield request shape: submit returns a request id plus status
and cancel URLs; clients poll the status endpoint with backoff, or receive a
signed Standard Webhooks delivery on terminal states with polling as fallback.

States: queued -> in_progress -> completed | failed | moderated | canceled.
Cancel is allowed only while queued; once in progress a job runs to a terminal
state. Jobs persist to a JSON file so they survive restarts.

Billing: only completed jobs are billable. Failed, moderated, and canceled
jobs carry billable=False so terminal moderation and failure never confuse
billing.

Safety: finished jobs hold artifacts and changeset *proposals* only. Nothing
here applies a changeset or touches source media; timeline mutation stays
gated on human accept in the UI.
"""

import base64
import binascii
import hashlib
import hmac
import json
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict

JobStatus = Literal["queued", "in_progress", "completed", "failed", "moderated", "canceled"]

RETENTION = timedelta(days=7)
_WEBHOOK_TOLERANCE_SECONDS = 5 * 60
_DELIVERY_TIMEOUT_SECONDS = 10.0


class JobNotFound(Exception):
    pass


class JobError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class JobConflict(JobError):
    pass


class JobInvalid(JobError):
    pass


class WebhookVerifyError(Exception):
    pass


class Artifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    content_type: str | None = None


class ChangesetProposal(BaseModel):
    """A proposed edit. Applying it is the UI's job after a human accepts."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["proposed"] = "proposed"
    ops: list[dict[str, Any]] = []


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    task: str
    input: dict[str, Any] = {}
    status: JobStatus = "queued"
    idempotency_key: str | None = None
    webhook_url: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    expires_at: datetime | None = None
    error: str | None = None
    artifacts: list[Artifact] = []
    changeset: ChangesetProposal | None = None
    billable: bool | None = None
    webhook_attempts: int = 0
    webhook_delivered: bool = False
    expired: bool = False


def _now() -> datetime:
    return datetime.now(UTC)


def poll_delay_seconds(attempt: int) -> float:
    """Backoff for status polling: 2s, doubling, capped at 10s."""
    return min(2.0 * 2 ** max(attempt, 0), 10.0)


def _secret_bytes(secret: str) -> bytes:
    try:
        return base64.b64decode(secret.removeprefix("whsec_"))
    except (binascii.Error, ValueError) as error:
        raise WebhookVerifyError("bad webhook secret") from error


def sign_delivery(
    secret: str, body: bytes, *, msg_id: str | None = None, timestamp: int | None = None
) -> dict[str, str]:
    """Standard Webhooks headers for one delivery."""
    msg_id = msg_id or f"msg_{uuid.uuid4().hex}"
    timestamp = timestamp if timestamp is not None else int(time.time())
    signed = f"{msg_id}.{timestamp}.".encode() + body
    mac = hmac.new(_secret_bytes(secret), signed, hashlib.sha256).digest()
    return {
        "webhook-id": msg_id,
        "webhook-timestamp": str(timestamp),
        "webhook-signature": f"v1,{base64.b64encode(mac).decode()}",
    }


def verify_delivery(
    secret: str, headers: Mapping[str, str], body: bytes, *, now: int | None = None
) -> None:
    """Verify a Standard Webhooks delivery; raises WebhookVerifyError."""
    lowered = {name.lower(): value for name, value in headers.items()}
    msg_id = lowered.get("webhook-id", "")
    timestamp = lowered.get("webhook-timestamp", "")
    signatures = lowered.get("webhook-signature", "")
    try:
        sent_at = int(timestamp)
    except ValueError:
        raise WebhookVerifyError("bad webhook timestamp") from None
    now = now if now is not None else int(time.time())
    if abs(now - sent_at) > _WEBHOOK_TOLERANCE_SECONDS:
        raise WebhookVerifyError("webhook timestamp outside tolerance")
    if not msg_id or not signatures:
        raise WebhookVerifyError("webhook signature missing")
    expected = sign_delivery(secret, body, msg_id=msg_id, timestamp=sent_at)["webhook-signature"]
    offered = [part.split(",", 1)[1] for part in signatures.split() if part.startswith("v1,")]
    want = expected.removeprefix("v1,")
    if not any(hmac.compare_digest(candidate, want) for candidate in offered):
        raise WebhookVerifyError("webhook signature mismatch")


def post_delivery(url: str, body: bytes, headers: dict[str, str]) -> None:
    with httpx.Client(timeout=_DELIVERY_TIMEOUT_SECONDS) as client:
        response = client.post(url, content=body, headers=headers)
        response.raise_for_status()


DeliverFn = Callable[[str, bytes, dict[str, str]], None]


class JobController:
    def __init__(
        self,
        path: str | Path,
        *,
        deliver: DeliverFn | None = None,
        webhook_secret: str | None = None,
    ) -> None:
        self._path = Path(path)
        self._deliver = deliver or post_delivery
        self._webhook_secret = webhook_secret
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._idempotency: dict[str, str] = {}
        self._load()

    def submit(
        self,
        task: str,
        input: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        webhook_url: str | None = None,
    ) -> Job:
        if not isinstance(task, str) or not task.strip():
            raise JobInvalid("invalid_task", "task must be a non-empty string")
        if input is not None and not isinstance(input, dict):
            raise JobInvalid("invalid_input", "input must be an object")
        if webhook_url is not None and (
            not isinstance(webhook_url, str) or not webhook_url.startswith("https://")
        ):
            raise JobInvalid("invalid_webhook_url", "webhook_url must be an https URL")
        key = idempotency_key or None
        with self._lock:
            if key is not None and key in self._idempotency:
                existing = self._jobs[self._idempotency[key]]
                if existing.task != task.strip() or existing.input != (input or {}):
                    raise JobConflict(
                        "idempotency_conflict", "idempotency key was used by another job"
                    )
                return existing
            job = Job(
                request_id=f"req_{uuid.uuid4().hex}",
                task=task.strip(),
                input=input or {},
                idempotency_key=key,
                webhook_url=webhook_url,
                created_at=_now(),
            )
            self._jobs[job.request_id] = job
            if key is not None:
                self._idempotency[key] = job.request_id
            self._save()
            return job

    def get(self, request_id: str) -> Job:
        with self._lock:
            try:
                return self._jobs[request_id]
            except KeyError:
                raise JobNotFound(request_id) from None

    def cancel(self, request_id: str) -> Job:
        with self._lock:
            job = self.get(request_id)
            if job.status != "queued":
                raise JobConflict("job_not_cancellable", "only queued jobs can be canceled")
            job.status = "canceled"
            job.finished_at = _now()
            job.billable = False
            self._save()
            return job

    def claim_next(self) -> Job | None:
        with self._lock:
            queued = sorted(
                (job for job in self._jobs.values() if job.status == "queued"),
                key=lambda job: job.created_at,
            )
            if not queued:
                return None
            job = queued[0]
            job.status = "in_progress"
            job.started_at = _now()
            self._save()
            return job

    def finish_completed(
        self,
        request_id: str,
        artifacts: list[dict[str, Any]] | None = None,
        ops: list[dict[str, Any]] | None = None,
    ) -> Job:
        with self._lock:
            job = self._running(request_id)
            validated = [Artifact.model_validate(item) for item in (artifacts or [])]
            changeset = ChangesetProposal(ops=ops or []) if ops else None
            job.status = "completed"
            job.finished_at = _now()
            job.expires_at = job.finished_at + RETENTION
            job.billable = True
            job.artifacts = validated
            job.changeset = changeset
            self._save()
        self._notify(request_id)
        return self.get(request_id)

    def finish_failed(self, request_id: str, error: str) -> Job:
        with self._lock:
            job = self._running(request_id)
            job.status = "failed"
            job.error = error
            job.finished_at = _now()
            job.billable = False
            self._save()
        self._notify(request_id)
        return self.get(request_id)

    def finish_moderated(self, request_id: str, reason: str) -> Job:
        with self._lock:
            job = self._running(request_id)
            job.status = "moderated"
            job.error = reason
            job.finished_at = _now()
            job.billable = False
            self._save()
        self._notify(request_id)
        return self.get(request_id)

    def prune_expired(self, now: datetime | None = None) -> int:
        """Drop artifacts past the 7-day retention window; records stay."""
        now = now or _now()
        pruned = 0
        with self._lock:
            for job in self._jobs.values():
                if job.expires_at is None or job.expired or job.expires_at > now:
                    continue
                job.artifacts = []
                job.expired = True
                pruned += 1
            if pruned:
                self._save()
        return pruned

    def _running(self, request_id: str) -> Job:
        job = self.get(request_id)
        if job.status != "in_progress":
            raise JobConflict("job_not_running", "only in-progress jobs can finish")
        return job

    def _notify(self, request_id: str) -> None:
        job = self.get(request_id)
        if job.webhook_url is None:
            return
        body = json.dumps(_envelope(job), default=str).encode()
        headers = (
            sign_delivery(self._webhook_secret, body) if self._webhook_secret is not None else {}
        )
        try:
            self._deliver(job.webhook_url, body, headers)
            delivered = True
        except Exception:
            delivered = False
        with self._lock:
            current = self._jobs.get(request_id)
            if current is not None:
                current.webhook_attempts += 1
                current.webhook_delivered = delivered
                self._save()

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            jobs = {key: Job.model_validate(value) for key, value in raw["jobs"].items()}
            idempotency = dict(raw.get("idempotency", {}))
        except (OSError, ValueError, KeyError):
            return
        for job in jobs.values():
            if job.status == "in_progress":
                job.status = "queued"
                job.started_at = None
        self._jobs = jobs
        self._idempotency = idempotency

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "jobs": {
                        key: job.model_dump(mode="json") for key, job in self._jobs.items()
                    },
                    "idempotency": self._idempotency,
                }
            ),
            encoding="utf-8",
        )
        tmp.replace(self._path)


def _envelope(job: Job) -> dict[str, Any]:
    payload: dict[str, Any] | None = None
    if job.status == "completed":
        payload = {"artifacts": [item.model_dump(mode="json") for item in job.artifacts]}
        if job.changeset is not None:
            payload["changeset"] = job.changeset.model_dump(mode="json")
    return {
        "request_id": job.request_id,
        "status": job.status,
        "error": job.error,
        "expires_at": job.expires_at,
        "payload": payload,
    }


class HandlerResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifacts: list[dict[str, Any]] = []
    ops: list[dict[str, Any]] = []


class Moderated(Exception):
    pass


TaskHandler = Callable[[Job], HandlerResult]


def run_worker(
    controller: JobController,
    handlers: Mapping[str, TaskHandler],
    *,
    interval: float = 1.0,
    stop: threading.Event | None = None,
) -> None:
    """Claim queued jobs and run them to a terminal state."""
    stop = stop if stop is not None else threading.Event()
    while not stop.is_set():
        job = controller.claim_next()
        if job is None:
            stop.wait(interval)
            continue
        handler = handlers.get(job.task)
        try:
            if handler is None:
                raise LookupError(f"unknown task: {job.task}")
            result = handler(job)
        except Moderated as error:
            controller.finish_moderated(job.request_id, str(error) or "moderated")
        except Exception as error:
            # A bad handler fails its job, never the worker.
            controller.finish_failed(job.request_id, f"{type(error).__name__}: {error}")
        else:
            try:
                controller.finish_completed(job.request_id, result.artifacts, result.ops)
            except Exception as error:
                # A bad handler result fails its job, never the worker.
                controller.finish_failed(job.request_id, f"{type(error).__name__}: {error}")
