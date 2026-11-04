import base64
import json
import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from chair_agent.assets import EditorUnlinkedError, build_assets, import_asset
from chair_agent.client import (
    build_client,
    configured_models,
    keys_configured,
    load_settings,
    set_key,
)
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
from chair_agent.projects import detect_projects
from chair_agent.review import ReviewUnavailable, build_review
from chair_agent.transcribe import handle_transcribe

HANDLERS: dict[str, TaskHandler] = {"transcribe": handle_transcribe, "edit": handle_edit}


class Handler(BaseHTTPRequestHandler):
    controller: JobController

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, _health())
            return
        if urlsplit(self.path).path == "/sounds":
            self._send(200, _sounds_body(self.path))
            return
        if urlsplit(self.path).path == "/projects":
            self._send(200, detect_projects())
            return
        project_id = _review_path(self.path)
        if project_id is not None:
            try:
                self._send(200, build_review(self.controller, project_id))
            except ReviewUnavailable as error:
                self._send(503, _error(error.code, str(error)))
            return
        project_id = _assets_path(self.path)
        if project_id is not None:
            try:
                self._send(200, build_assets(project_id))
            except ReviewUnavailable as error:
                self._send(503, _error(error.code, str(error)))
            return
        request_id = _job_path(self.path)
        if request_id is None:
            self.send_error(404)
            return
        try:
            self._send(200, _job_body(self._base_url(), self.controller.get(request_id)))
        except JobNotFound:
            self._send(404, _error("job_not_found", "unknown request id"))

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type, idempotency-key")
        self.end_headers()

    def do_POST(self) -> None:
        if self.path == "/keys":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            if "keys" in body and isinstance(body["keys"], dict):
                for prov, val in body["keys"].items():
                    set_key(prov, val if isinstance(val, str) else None)
            elif "provider" in body and isinstance(body["provider"], str):
                val = body.get("key")
                set_key(body["provider"], val if isinstance(val, str) else None)
            else:
                for prov in ("meta", "openai", "anthropic"):
                    if prov in body:
                        val = body[prov]
                        set_key(prov, val if isinstance(val, str) else None)
            self._send(200, {"ok": True, "keys_configured": keys_configured()})
            return
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
        sounds_path = urlsplit(self.path).path
        if sounds_path in ("/sounds/refresh", "/sounds/pick", "/sounds/fetch"):
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            if sounds_path == "/sounds/refresh":
                self._send(200, _sounds_refresh_body())
                return
            if sounds_path == "/sounds/pick":
                try:
                    self._send(200, _sounds_pick_body(body))
                except ValueError as error:
                    self._send(400, _error("invalid_sounds_pick", str(error)))
                return
            try:
                self._send(200, _sounds_fetch_body(body))
            except ValueError as error:
                self._send(400, _error("invalid_sounds_fetch", str(error)))
            return
        project_id = _assets_path(self.path)
        if project_id is not None:
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                asset = import_asset(
                    project_id, body.get("name"), _import_bytes(body.get("data"))
                )
            except EditorUnlinkedError as error:
                self._send(409, _error("editor_unlinked", str(error)))
            except ValueError as error:
                self._send(400, _error("invalid_asset", str(error)))
            except ReviewUnavailable as error:
                self._send(503, _error(error.code, str(error)))
            else:
                self._send(200, {"project_id": project_id, "asset": asset})
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
        # The desktop window is a different origin; without this the
        # browser blocks reads and the service always looks down.
        # Responses here never carry secrets (see the health test).
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def _review_path(path: str) -> str | None:
    parts = urlsplit(path).path.strip("/").split("/")
    if len(parts) == 3 and parts[0] == "projects" and parts[1] and parts[2] == "review":
        return unquote(parts[1])
    return None


def _assets_path(path: str) -> str | None:
    parts = urlsplit(path).path.strip("/").split("/")
    if len(parts) == 3 and parts[0] == "projects" and parts[1] and parts[2] == "assets":
        return unquote(parts[1])
    return None


def _import_bytes(data: Any) -> bytes:
    if not isinstance(data, str) or not data:
        raise ValueError("Import needs base64 file data.")
    try:
        return base64.b64decode(data, validate=True)
    except ValueError as error:
        raise ValueError("Import data is not valid base64.") from error


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
    from chair_agent import sounds

    keys_status = keys_configured()
    return {
        "service": "agent",
        "ok": True,
        "tools": [tool.model_dump() for tool in TOOLS],
        "models": configured_models(),
        "key_configured": keys_status.get("meta", False),
        "keys_configured": keys_status,
        "keys": keys_status,
        "sounds": sounds.status_snapshot(),
    }


def _sounds_body(path: str) -> dict[str, Any]:
    from chair_agent import sounds

    query = dict(urllib.parse.parse_qsl(urlsplit(path).query))
    entries = sounds.search_library(
        sounds.get_library(),
        query=query.get("q", ""),
        tag=query.get("tag", ""),
        source=query.get("source", ""),
    )
    body: dict[str, Any] = {
        "sounds": [entry.model_dump(mode="json") for entry in entries],
        "counts": sounds.status_snapshot()["counts"],
    }
    api_key = (os.environ.get("FREESOUND_API_KEY") or "").strip()
    if query.get("q", "").strip() and api_key:
        try:
            remote = sounds.search_freesound(query["q"].strip(), api_key)
            body["sounds"].extend(entry.model_dump(mode="json") for entry in remote)
            body["freesound"] = len(remote)
        except Exception as error:
            body["freesound_error"] = str(error) or error.__class__.__name__
    return body


def _sounds_refresh_body() -> dict[str, Any]:
    from chair_agent import sounds

    entries = sounds.refresh_library()
    return {"sounds": len(entries), "counts": sounds.status_snapshot()["counts"]}


def _cue_client() -> Any | None:
    try:
        settings = load_settings()
    except Exception:
        return None
    if not settings.models.executor or not settings.api_key:
        return None
    try:
        return build_client()
    except Exception:
        return None


def _sounds_pick_body(body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import sounds

    brief = body.get("brief", "")
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("pick needs a non-empty 'brief' string")
    context = sounds.CueContext.model_validate({
        "cuts": body.get("cuts", []),
        "beats": body.get("beats", []),
        "words": body.get("words", []),
    })
    entries = sounds.get_library()
    cues, picker = sounds.pick_cues(brief, context, entries, client=_cue_client())
    changeset = sounds.cues_to_changeset(
        cues,
        entries,
        changeset_id=str(body.get("changeset_id") or "cs-sounds-1"),
        base_revision=str(body.get("base_revision") or "rev-0"),
    )
    return {
        "picker": picker,
        "cues": [cue.model_dump(mode="json") for cue in cues],
        "changeset": changeset.model_dump(mode="json", by_alias=True),
    }


def _sounds_fetch_body(body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import sounds

    wanted = body.get("id", "")
    if not isinstance(wanted, str) or not wanted.strip():
        raise ValueError("fetch needs an entry 'id'")
    api_key = (os.environ.get("FREESOUND_API_KEY") or "").strip()
    if not api_key:
        raise ValueError("fetch needs FREESOUND_API_KEY")
    entry = next((e for e in sounds.get_library() if e.id == wanted), None)
    if entry is None:
        raise ValueError(f"unknown sound entry: {wanted!r}")
    dest = sounds.fetch_freesound_entry(entry, api_key=api_key)
    return {"id": entry.id, "path": str(dest)}


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
