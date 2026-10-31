import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from chair_agent.client import configured_models
from chair_agent.jobs import (
    Job,
    JobConflict,
    JobController,
    JobInvalid,
    JobNotFound,
    TaskHandler,
    run_worker,
)
from chair_agent.loop import handle_edit
from chair_agent.models import TOOLS

HANDLERS: dict[str, TaskHandler] = {"edit": handle_edit}


class Handler(BaseHTTPRequestHandler):
    controller: JobController

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, _health())
            return
        request_id = _job_path(self.path)
        if request_id is None:
            self.send_error(404)
            return
        try:
            self._send(200, _job_body(self._base_url(), self.controller.get(request_id)))
        except JobNotFound:
            self._send(404, _error("job_not_found", "unknown request id"))

    def do_POST(self) -> None:
        if self.path == "/jobs":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                job = self.controller.submit(
                    body.get("task", ""),
                    body.get("input"),
                    idempotency_key=self.headers.get("Idempotency-Key")
                    or body.get("idempotency_key"),
                    webhook_url=body.get("webhook_url"),
                )
            except JobInvalid as error:
                self._send(400, _error(error.code, str(error)))
            except JobConflict as error:
                self._send(409, _error(error.code, str(error)))
            else:
                self._send(200, _handle_body(self._base_url(), job))
            return
        request_id = _cancel_path(self.path)
        if request_id is None:
            self.send_error(404)
            return
        try:
            job = self.controller.cancel(request_id)
        except JobNotFound:
            self._send(404, _error("job_not_found", "unknown request id"))
        except JobConflict as error:
            self._send(409, _error(error.code, str(error)))
        else:
            self._send(200, _job_body(self._base_url(), job))

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return payload

    def _base_url(self) -> str:
        return f"http://{self.headers.get('host', '127.0.0.1:8787')}"

    def _send(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def _job_path(path: str) -> str | None:
    parts = path.strip("/").split("/")
    if len(parts) == 2 and parts[0] == "jobs" and parts[1]:
        return parts[1]
    return None


def _cancel_path(path: str) -> str | None:
    parts = path.strip("/").split("/")
    if len(parts) == 3 and parts[0] == "jobs" and parts[1] and parts[2] == "cancel":
        return parts[1]
    return None


def _health() -> dict[str, Any]:
    return {
        "service": "agent",
        "ok": True,
        "tools": [tool.model_dump() for tool in TOOLS],
        "models": configured_models(),
    }


def _handle_body(base_url: str, job: Job) -> dict[str, Any]:
    return {
        "request_id": job.request_id,
        "status": job.status,
        "status_url": f"{base_url}/jobs/{job.request_id}",
        "cancel_url": f"{base_url}/jobs/{job.request_id}/cancel",
        "expires_at": job.expires_at,
    }


def _job_body(base_url: str, job: Job) -> dict[str, Any]:
    body = job.model_dump(mode="json")
    body["status_url"] = f"{base_url}/jobs/{job.request_id}"
    body["cancel_url"] = f"{base_url}/jobs/{job.request_id}/cancel"
    return body


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def _state_path() -> Path:
    root = os.environ.get("CHAIR_AGENT_STATE_DIR")
    if root:
        return Path(root) / "jobs.json"
    return Path.home() / ".local" / "share" / "chair" / "agent" / "jobs.json"


def main() -> None:
    host = os.environ.get("CHAIR_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("CHAIR_AGENT_PORT", "8787"))
    Handler.controller = JobController(
        _state_path(), webhook_secret=os.environ.get("CHAIR_WEBHOOK_SECRET")
    )
    Handler.controller.prune_expired()
    worker = threading.Thread(
        target=run_worker, args=(Handler.controller, HANDLERS), daemon=True
    )
    worker.start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"chair-agent listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
