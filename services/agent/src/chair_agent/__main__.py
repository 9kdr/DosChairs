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
        module_route = _module_paths(self.path)
        if module_route is not None:
            self._module_get(*module_route)
            return
        kind, effect_id = _effect_paths(self.path)
        if kind == "effect" and effect_id is not None:
            try:
                self._send(200, _effect_body(effect_id))
            except Exception as error:
                self._send(_effects_status(error), _error("invalid_effect", str(error)))
            return
        if urlsplit(self.path).path == "/sounds":
            self._send(200, _sounds_body(self.path))
            return
        if urlsplit(self.path).path == "/pieces/macros":
            self._send(200, _pieces_body(self.path))
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
        module_route = _module_paths(self.path)
        if module_route is not None:
            self._module_post(*module_route)
            return
        effects_path = urlsplit(self.path).path
        if effects_path == "/effects/generate":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                self._send(200, _effects_generate_body(body))
            except Exception as error:
                self._send(_effects_status(error), _error("invalid_effect", str(error)))
            return
        kind, effect_id = _effect_paths(self.path)
        if kind == "verify" and effect_id is not None:
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                self._send(200, _effects_verify_body(effect_id, body))
            except Exception as error:
                self._send(_effects_status(error), _error("invalid_effect", str(error)))
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

    def _module_get(self, action: str, module_id: str | None, name: str | None) -> None:
        from chair_agent import modules

        try:
            if action == "record" and module_id is not None:
                self._send(200, modules.get_module(module_id).model_dump(mode="json"))
            elif action == "preview" and module_id is not None:
                self._send_raw(200, modules.preview_for(module_id).encode(), "text/html")
            elif action == "file" and module_id is not None and name is not None:
                path = modules.build_file(module_id, name)
                kind = "application/javascript" if path.suffix == ".js" else "application/json"
                self._send_raw(200, path.read_bytes(), kind)
            else:
                self.send_error(404)
        except Exception as error:
            self._send(_modules_status(error), _error("invalid_module", str(error)))

    def _module_post(self, action: str, module_id: str | None, name: str | None) -> None:
        from chair_agent import modules

        try:
            body = self._body()
        except ValueError:
            self._send(400, _error("invalid_json", "request body must be JSON"))
            return
        try:
            if action == "generate":
                self._send(200, _modules_generate_body(body))
            elif action == "import":
                record = modules.register_source(
                    str(body.get("source", "")), brief=str(body.get("brief", ""))
                )
                self._send(200, _module_summary(record))
            elif action == "bundle" and module_id is not None:
                self._send(200, _module_summary(modules.bundle_module(
                    module_id, keyframes=body.get("keyframes"),
                )))
            elif action == "install" and module_id is not None:
                dest = body.get("dest")
                self._send(200, modules.install_module(
                    module_id, dest=dest if isinstance(dest, str) and dest else None
                ))
            else:
                self.send_error(404)
        except Exception as error:
            self._send(_modules_status(error), _error("invalid_module", str(error)))

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

    def _send_raw(self, status: int, raw: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", f"{content_type}; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def _effect_paths(path: str) -> tuple[str, str | None]:
    """Split /effects/<id> and /effects/<id>/verify; else ("", None)."""
    parts = urlsplit(path).path.strip("/").split("/")
    if len(parts) == 2 and parts[0] == "effects" and parts[1]:
        return ("effect", unquote(parts[1]))
    if len(parts) == 3 and parts[0] == "effects" and parts[1] and parts[2] == "verify":
        return ("verify", unquote(parts[1]))
    return ("", None)


def _module_paths(path: str) -> tuple[str, str | None, str | None] | None:
    """Route /effects/modules/...; None when the path is not a module path."""
    parts = [unquote(p) for p in urlsplit(path).path.strip("/").split("/")]
    if len(parts) < 3 or parts[0] != "effects" or parts[1] != "modules":
        return None
    if len(parts) == 3:
        if parts[2] in ("generate", "import"):
            return (parts[2], None, None)
        return ("record", parts[2], None)
    if len(parts) == 4 and parts[3] in ("bundle", "install", "preview"):
        return (parts[3], parts[2], None)
    if len(parts) == 5 and parts[3] == "files":
        return ("file", parts[2], parts[4])
    return ("", None, None)


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


def _pipeline() -> dict[str, Any]:
    """Checkable pipeline numbers: jobs, last error, plan time, effect repairs."""
    from chair_agent import effects, planner

    pipeline: dict[str, Any] = {
        "jobs_queued": 0,
        "jobs_done": 0,
        "jobs_failed": 0,
        "last_error": None,
        "last_plan_ms": None,
        "effect_repairs_used": 0,
    }
    controller = getattr(Handler, "controller", None)
    if controller is not None:
        jobs = controller.summary()
        pipeline["jobs_queued"] = jobs["queued"]
        pipeline["jobs_done"] = jobs["completed"]
        pipeline["jobs_failed"] = jobs["failed"]
        pipeline["last_error"] = jobs["last_error"]
    plans = planner.status_snapshot()
    pipeline["last_plan_ms"] = plans["last_plan_ms"]
    pipeline["effect_repairs_used"] = effects.status_snapshot()["repairs"]
    if pipeline["last_error"] is None:
        pipeline["last_error"] = plans["last_error"] or effects.status_snapshot()["last_error"]
    return pipeline


def _health() -> dict[str, Any]:
    from chair_agent import effects, modules, sounds
    from chair_agent.pieces import macros

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
        "effects": effects.status_snapshot(),
        "macros": macros.status_snapshot(),
        "modules": modules.status_snapshot() | {"model": modules.module_model()},
        "pipeline": _pipeline(),
    }


def _pieces_body(path: str) -> dict[str, Any]:
    from chair_agent.pieces import macros

    query = dict(urllib.parse.parse_qsl(urlsplit(path).query))
    try:
        limit = int(query.get("limit", "50"))
    except ValueError:
        limit = 50
    body = macros.list_pieces(
        query.get("q", ""), limit=limit, rescan=query.get("rescan") == "1"
    )
    body["counts"] = macros.status_snapshot()["counts"]
    return body


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


def _effects_status(error: Exception) -> int:
    from chair_agent import effects
    from chair_agent.effects import InvalidEffect

    if isinstance(error, InvalidEffect):
        return effects.error_status(error)
    return 400


def _modules_status(error: Exception) -> int:
    from chair_agent import modules
    from chair_agent.modules import InvalidModule

    if isinstance(error, InvalidModule):
        return modules.error_status(error)
    return 400


def _module_summary(record: Any) -> dict[str, Any]:
    dumped = record.model_dump(mode="json")
    return {
        "id": dumped["id"],
        "meta": dumped["meta"],
        "props": dumped["props"],
        "checks": dumped["checks"],
        "warnings": dumped["warnings"],
        "stem": dumped["stem"],
        "files": dumped["files"],
        "keyframes": dumped["keyframes"],
        "notes": dumped["notes"],
        "repaired": dumped["repaired"],
        "preview": f"/effects/modules/{dumped['id']}/preview",
    }


def _modules_generate_body(body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import modules

    canvas = body.get("canvas", {})
    if not isinstance(canvas, dict):
        raise ValueError("generate needs a 'canvas' object with width and height")
    try:
        width = int(canvas.get("width", 1920))
        height = int(canvas.get("height", 1080))
        fps = float(body.get("fps", 30))
        duration_sec = float(body.get("durationSec", 8))
    except (TypeError, ValueError) as error:
        raise ValueError(f"bad generate body: {error}") from error
    references = body.get("references")
    pieces = body.get("pieces")
    mode = body.get("mode", "spark")
    if mode not in modules.MODES:
        raise ValueError("mode must be 'spark' or 'wonder'")
    record = modules.generate_module(
        str(body.get("brief", "")),
        kind=body.get("kind") if isinstance(body.get("kind"), str) else None,
        width=width,
        height=height,
        fps=fps,
        duration_sec=duration_sec,
        references=references if isinstance(references, list) else None,
        piece_ids=[str(p) for p in pieces] if isinstance(pieces, list) else None,
        model=modules.WONDER_MODULE_MODEL if mode == "wonder" else None,
        mode=mode,
    )
    return _module_summary(record)


def _effect_body(effect_id: str) -> dict[str, Any]:
    from chair_agent import effects

    record = effects.get_effect(effect_id)
    return record.model_dump(mode="json")


def _effects_generate_body(body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import effects

    canvas = body.get("canvas", {})
    if not isinstance(canvas, dict):
        raise ValueError("generate needs a 'canvas' object with width and height")
    try:
        width = int(canvas.get("width", 0))
        height = int(canvas.get("height", 0))
        fps = float(body.get("fps", 0))
        duration_sec = float(body.get("durationSec", 0))
    except (TypeError, ValueError) as error:
        raise ValueError(f"bad generate body: {error}") from error
    record = effects.generate_effect(
        str(body.get("prompt", "")),
        width=width,
        height=height,
        fps=fps,
        duration_sec=duration_sec,
        rig=body.get("rig") if isinstance(body.get("rig"), dict) else None,
        reference_image=body.get("referenceImage")
        if isinstance(body.get("referenceImage"), str) else None,
        references=body.get("references") if isinstance(body.get("references"), list) else None,
    )
    dumped = record.model_dump(mode="json")
    return {"id": dumped["id"], "spec": dumped["spec"], "notes": dumped["notes"]}


def _effects_verify_body(effect_id: str, body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import effects

    record, passed, notes = effects.verify_effect(
        effect_id,
        preview_png=str(body.get("previewPng", "")),
        reference_png=str(body.get("referencePng", ""))
        if isinstance(body.get("referencePng"), str) else None,
        resolve_still_png=str(body.get("resolveStillPng", ""))
        if isinstance(body.get("resolveStillPng"), str) else None,
    )
    out: dict[str, Any] = {"pass": passed, "notes": notes}
    if not passed:
        out["revisedSpec"] = record.spec
    return out


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
    from chair_agent.pieces import macros

    threading.Thread(target=macros.get_scan, daemon=True).start()  # warm the macro scan
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"chair-agent listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
