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
from chair_agent.crew import handle_direct
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

HANDLERS: dict[str, TaskHandler] = {
    "transcribe": handle_transcribe, "edit": handle_edit, "direct": handle_direct,
}


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
        plan_route = _plan_path(self.path)
        if plan_route is not None and plan_route[1] == "":
            from chair_agent import plans as plan_store

            try:
                self._send(200, plan_store.plan_payload(
                    plan_store.load_plan(plan_route[0])))
            except plan_store.PlanError as error:
                self._send(400, _error("invalid_plan", str(error)))
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
        self.send_header("access-control-allow-methods", "GET, POST, PUT, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type, idempotency-key")
        self.end_headers()

    def do_PUT(self) -> None:
        plan_route = _plan_path(self.path)
        if plan_route is None or plan_route[1] != "":
            self.send_error(404)
            return
        from chair_agent import plans as plan_store

        try:
            body = self._body()
        except ValueError:
            self._send(400, _error("invalid_json", "request body must be JSON"))
            return
        front = body.get("front", body)
        try:
            plan = plan_store.save_front(plan_route[0], front)
            if isinstance(body.get("status"), str):
                plan = plan_store.set_status(plan_route[0], body["status"])
        except plan_store.PlanError as error:
            self._send(400, _error("invalid_plan", str(error)))
            return
        self._send(200, plan_store.plan_payload(plan))

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
        if sounds_path in ("/sounds/apply", "/sounds/undo"):
            try:
                body = self._body()
            except ValueError:
                self._send(400, {"error": "request body must be JSON"})
                return
            try:
                if sounds_path == "/sounds/apply":
                    self._send(200, _sounds_apply_body(body, self.controller))
                else:
                    self._send(200, _sounds_undo_body(body))
            except _SoundsApplyError as error:
                self._send(error.status, {"error": str(error)})
            return
        cuts_path = urlsplit(self.path).path
        if cuts_path in ("/cuts/apply", "/cuts/undo"):
            from chair_agent import cuts

            try:
                body = self._body()
            except ValueError:
                self._send(400, {"error": "request body must be JSON"})
                return
            try:
                if cuts_path == "/cuts/apply":
                    self._send(200, _cuts_apply_body(body, self.controller))
                else:
                    self._send(200, _cuts_undo_body(body))
            except _CutsApplyError as error:
                if cuts_path == "/cuts/apply":
                    cuts.note_applied(skipped_ops=0, write_ms=0.0, error=str(error))
                else:
                    cuts.note_undone(error=str(error))
                self._send(error.status, {"error": str(error)})
            return
        module_route = _module_paths(self.path)
        if module_route is not None:
            self._module_post(*module_route)
            return
        effects_path = urlsplit(self.path).path
        if effects_path == "/effects/rig/generate":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                self._send(200, _rig_generate_body(body))
            except Exception as error:
                self._send(_rig_status(error), _error("invalid_rig", str(error)))
            return
        if effects_path == "/effects/rig/apply":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                self._send(200, _rig_apply_body(body))
            except _ResolveUnavailable as error:
                self._send(503, _error("resolve_unavailable", str(error)))
            except _ResolveFailed as error:
                self._send(502, _error("resolve_failed", str(error)))
            except Exception as error:
                from chair_agent.piece_bake import BakeError

                if isinstance(error, BakeError):
                    self._send(error.status, _error("bake_failed", str(error)))
                else:
                    self._send(_rig_status(error), _error("invalid_rig", str(error)))
            return
        if effects_path == "/effects/rig/revert":
            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                self._send(200, _rig_revert_body(body))
            except _ResolveUnavailable as error:
                self._send(503, _error("resolve_unavailable", str(error)))
            except _ResolveFailed as error:
                self._send(502, _error("resolve_failed", str(error)))
            except Exception as error:
                self._send(_rig_status(error), _error("invalid_rig", str(error)))
            return
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
        plan_route = _plan_path(urlsplit(self.path).path)
        if plan_route is not None and plan_route[1] in ("generate", "digest"):
            from chair_agent import plans as plan_store

            try:
                body = self._body()
            except ValueError:
                self._send(400, _error("invalid_json", "request body must be JSON"))
                return
            try:
                if plan_route[1] == "generate":
                    plan = plan_store.generate_back(plan_route[0])
                else:
                    item_id = body.get("itemId", "")
                    if not isinstance(item_id, str) or not item_id.strip():
                        raise plan_store.PlanError(
                            "digest needs an 'itemId' string")
                    plan = plan_store.digest_item(plan_route[0], item_id.strip())
            except plan_store.PlanError as error:
                self._send(400, _error("invalid_plan", str(error)))
                return
            self._send(200, plan_store.plan_payload(plan))
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


def _plan_path(path: str) -> tuple[str, str] | None:
    """Split /projects/:id/plan[/generate|/digest]; None when not a plan path."""
    parts = urlsplit(path).path.strip("/").split("/")
    if len(parts) < 3 or parts[0] != "projects" or not parts[1] or parts[2] != "plan":
        return None
    if len(parts) == 3:
        return (unquote(parts[1]), "")
    if len(parts) == 4 and parts[3] in ("generate", "digest"):
        return (unquote(parts[1]), parts[3])
    return ("", "")


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
    from chair_agent import cuts, effects, modules, piece_bake, rig, sounds
    from chair_agent.client import auth_status_snapshot
    from chair_agent.pieces import macros

    keys_status = keys_configured()
    auth_status = auth_status_snapshot()
    return {
        "service": "agent",
        "ok": True,
        "tools": [tool.model_dump() for tool in TOOLS],
        "models": configured_models(),
        "key_configured": keys_status.get("meta", False),
        "keys_configured": keys_status,
        "keys": keys_status,
        "last_auth_error": auth_status["last_auth_error"],
        "last_auth_error_at": auth_status["last_auth_error_at"],
        "sounds": sounds.status_snapshot(),
        "cuts": cuts.status_snapshot(),
        "effects": effects.status_snapshot(),
        "rig": rig.status_snapshot(),
        "macros": macros.status_snapshot(),
        "modules": modules.status_snapshot() | {"model": modules.module_model()},
        "piece_bake": piece_bake.status_snapshot(),
        "pipeline": _pipeline(),
        "crew": _crew_status(),
    }


def _crew_status() -> dict[str, Any]:
    """Crew counters for /health; zeros when the crew never ran."""
    from chair_agent.crew import status_snapshot

    return status_snapshot()


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


class _ResolveUnavailable(Exception):
    pass


class _ResolveFailed(Exception):
    pass


def _rig_status(error: Exception) -> int:
    from chair_agent import rig
    from chair_agent.rig import InvalidRig

    if isinstance(error, InvalidRig):
        return rig.error_status(error)
    return 400


def _rig_generate_body(body: dict[str, Any]) -> dict[str, Any]:
    from chair_agent import rig

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
    return rig.generate_rig(
        str(body.get("brief", "")),
        width=width,
        height=height,
        fps=fps,
        duration_sec=duration_sec,
    )


def _resolve_project(project_name: Any) -> Any:
    """The open Studio project. Never switches projects on its own.

    Raises _ResolveUnavailable without the adapter/scripting host,
    _ResolveFailed when no project is open or the named one is not open.
    """
    try:
        from chair_resolve.read import (  # noqa: F401
            resolve_app,
            scripting_module_paths,
        )
    except ImportError as error:
        raise _ResolveUnavailable(
            "the Resolve adapter or scripting host is missing here; run the "
            f"agent where chair-adapter-resolve and DaVinciResolveScript import ({error})"
        ) from error
    try:
        import DaVinciResolveScript as bmd
    except ImportError:
        import sys as _sys

        for path in scripting_module_paths():
            if path not in _sys.path:
                _sys.path.insert(0, path)
        try:
            import DaVinciResolveScript as bmd
        except ImportError as error:
            raise _ResolveUnavailable(
                "the Resolve adapter or scripting host is missing here; run the "
                "agent where chair-adapter-resolve and DaVinciResolveScript "
                f"import ({error})"
            ) from error
    try:
        resolve = bmd.scriptapp("Resolve")
        manager = resolve.GetProjectManager()
        project = manager.GetCurrentProject()
        if project is None:
            raise _ResolveFailed("Resolve Studio has no project open.")
        if isinstance(project_name, str) and project_name.strip():
            if project.GetName() != project_name.strip():
                raise _ResolveFailed(
                    f"Project {project_name.strip()!r} is not open in Resolve "
                    f"(open {project.GetName()!r}); the route never switches "
                    "projects on its own."
                )
        return project
    except (_ResolveUnavailable, _ResolveFailed):
        raise
    except Exception as error:
        raise _ResolveFailed(f"Resolve scripting failed: {error}") from error


def _find_timeline_by_name(project: Any, wanted: str) -> Any | None:
    """One project timeline by name. None when it is not in the project."""
    count = project.GetTimelineCount() or 0
    for index in range(1, count + 1):
        candidate = project.GetTimelineByIndex(index)
        if candidate is not None and candidate.GetName() == wanted:
            return candidate
    return None


def _resolve_project_timeline(project_name: Any, timeline_name: Any) -> tuple[Any, Any]:
    """Open project plus named (or current) timeline. Never creates anything.

    Returns (project, timeline). Raises _ResolveUnavailable without the
    adapter/scripting host, _ResolveFailed when the names do not resolve.
    """
    project = _resolve_project(project_name)
    try:
        timeline = None
        if isinstance(timeline_name, str) and timeline_name.strip():
            wanted = timeline_name.strip()
            timeline = _find_timeline_by_name(project, wanted)
            if timeline is None:
                raise _ResolveFailed(f"Timeline {wanted!r} is not in this project.")
        else:
            timeline = project.GetCurrentTimeline()
        if timeline is None:
            raise _ResolveFailed("Resolve Studio has no current timeline.")
        return project, timeline
    except _ResolveFailed:
        raise
    except Exception as error:
        raise _ResolveFailed(f"Resolve scripting failed: {error}") from error


def _resolve_timeline_item(
    project_name: Any, timeline_name: Any, track_type: str, track_index: int,
    clip_index: int,
) -> tuple[Any, str, str]:
    """Find a timeline clip through Studio scripting. Never creates anything.

    Returns (item, project name, timeline name). Raises _ResolveUnavailable
    without the adapter/scripting host, _ResolveFailed when the names or
    the clip do not resolve.
    """
    try:
        from chair_resolve import add_effect as _add  # noqa: F401
    except ImportError as error:
        raise _ResolveUnavailable(
            f"chair-adapter-resolve is not importable ({error})"
        ) from error
    del _add
    project, timeline = _resolve_project_timeline(project_name, timeline_name)
    try:
        items = timeline.GetItemListInTrack(track_type, track_index) or []
        if clip_index < 0 or clip_index >= len(items):
            raise _ResolveFailed(
                f"Clip {clip_index} is not on {track_type} track {track_index} "
                f"(has {len(items)} clips)."
            )
        return items[clip_index], project.GetName(), timeline.GetName()
    except _ResolveFailed:
        raise
    except Exception as error:
        raise _ResolveFailed(f"Resolve scripting failed: {error}") from error


def _rig_apply_body(body: dict[str, Any]) -> dict[str, Any]:
    """Apply a baked rig (or plain spec) to a Resolve clip as a new comp version.

    add_effect always lands on a NEW comp version: the current one stays
    untouched, and prev_comp_name in the answer is the undo back.
    """
    from chair_agent import rig  # noqa: F401  (keeps the route's errors typed)
    from chair_agent.effects import InvalidEffect, get_effect

    spec = body.get("spec")
    if not isinstance(spec, dict):
        effect_id = body.get("effectId", "")
        if not isinstance(effect_id, str) or not effect_id.strip():
            raise InvalidEffect("apply needs an inline 'spec' or an 'effectId'")
        spec = get_effect(effect_id.strip()).spec
    baked = body.get("baked")
    if baked is not None and not isinstance(baked, dict):
        raise InvalidEffect("apply 'baked' must map layer id to prop key lists")
    sequences = body.get("sequences")
    if sequences is not None and not isinstance(sequences, dict):
        raise InvalidEffect("apply 'sequences' must map layer id to {files: [...]}")
    try:
        track_index = int(body.get("trackIndex", 1))
        clip_index = int(body.get("clipIndex", 0))
    except (TypeError, ValueError) as error:
        raise InvalidEffect(f"bad apply body: {error}") from error
    track_type = body.get("trackType", "video")
    if track_type not in ("video", "audio"):
        raise InvalidEffect("apply 'trackType' must be 'video' or 'audio'")
    item, project_name, timeline_name = _resolve_timeline_item(
        body.get("project"), body.get("timeline"), track_type, track_index, clip_index,
    )
    from chair_agent import piece_bake
    from chair_agent.piece_bake import BakeError  # noqa: F401  (caught by the route)

    notes: list[str] = []
    if piece_bake.ograf_unavailable():
        sequences, notes = piece_bake.bake_for_apply(spec, sequences)
    from chair_resolve import add_effect

    try:
        op = add_effect(
            item, dict(spec), baked=baked, sequences=sequences,
            cache_dir=body.get("cacheDir") or None,
        )
    except Exception as error:
        raise _ResolveFailed(f"add_effect failed: {error}") from error
    if "fallback" in op:
        return {
            "effect_id": spec.get("id"),
            "fallback": op["fallback"],
            "project": project_name,
            "timeline": timeline_name,
        }
    keyframes = 0
    if isinstance(baked, dict):
        for props in baked.values():
            if not isinstance(props, dict):
                continue
            for keys in props.values():
                if isinstance(keys, list):
                    keyframes += len(keys)
    answer: dict[str, Any] = {
        "effect_id": op.get("effect_id"),
        "comp_name": op.get("comp_name"),
        "prev_comp_name": op.get("prev_comp_name"),
        "paths": op.get("paths", {}),
        "keyframes": keyframes,
        "project": project_name,
        "timeline": timeline_name,
        "undo": op.get("undo"),
    }
    if notes:
        answer["notes"] = "; ".join(notes)
    return answer


def _rig_revert_body(body: dict[str, Any]) -> dict[str, Any]:
    """Undo a piece apply: the previous comp version stands again.

    Takes the apply answer's op (or the desktop's toComp): remove_effect
    switches back when the Fusion UI is already up, else removes the added
    version. Never touches any other clip or project.
    """
    from chair_agent.effects import InvalidEffect

    op = body.get("op")
    if isinstance(op, dict):
        op = dict(op)
    else:
        to_comp = body.get("toComp", "")
        if not isinstance(to_comp, str) or not to_comp.strip():
            raise InvalidEffect("revert needs an 'op' or a 'toComp'")
        op = {"undo": {"prev_comp_name": to_comp.strip()}}
    try:
        track_index = int(body.get("trackIndex", 1))
        clip_index = int(body.get("clipIndex", 0))
    except (TypeError, ValueError) as error:
        raise InvalidEffect(f"bad revert body: {error}") from error
    track_type = body.get("trackType", "video")
    if track_type not in ("video", "audio"):
        raise InvalidEffect("revert 'trackType' must be 'video' or 'audio'")
    item, project_name, timeline_name = _resolve_timeline_item(
        body.get("project"), body.get("timeline"), track_type, track_index, clip_index,
    )
    from chair_resolve import remove_effect

    try:
        undone = remove_effect(item, op)
    except Exception as error:
        raise _ResolveFailed(f"remove_effect failed: {error}") from error
    if not undone:
        raise _ResolveFailed("Resolve could not undo this piece.")
    undo = op.get("undo") or {}
    prev = undo.get("prev_comp_name", op.get("prev_comp_name"))
    return {
        "comp_name": prev if isinstance(prev, str) else None,
        "project": project_name,
        "timeline": timeline_name,
    }


_SOUND_APPLY_OPS = frozenset({"add_track", "add_clip", "set_gain"})


class _SoundsApplyError(Exception):
    """A /sounds/apply or /sounds/undo failure: status plus one plain sentence."""

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        super().__init__(message)


def _sounds_coerce_items(raw_items: Any, where: str) -> list[Any]:
    """Raw dicts to typed items. Raises _SoundsApplyError naming the bad item."""
    from pydantic import ValidationError

    from chair_agent.edit_ops import ChangesetItem

    if not isinstance(raw_items, list) or not raw_items:
        raise _SoundsApplyError(400, f"{where} holds no items to apply")
    items = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise _SoundsApplyError(400, f"{where} item {index} must be an object")
        try:
            items.append(ChangesetItem.model_validate(raw))
        except ValidationError as error:
            first = error.errors()[0]
            at = ".".join(str(part) for part in first.get("loc", ()))
            raise _SoundsApplyError(
                400, f"{where} item {index} is not a changeset item ({at}: {first['msg']})"
            ) from error
    return items


def _sounds_job_items(controller: JobController, job_id: str) -> list[Any]:
    """A finished job's proposal. Raises _SoundsApplyError when it cannot apply."""
    try:
        job = controller.get(job_id)
    except JobNotFound:
        raise _SoundsApplyError(404, f"job {job_id!r} is unknown") from None
    if job.status != "completed":
        if job.status in ("failed", "moderated", "canceled"):
            raise _SoundsApplyError(
                400, f"job {job_id!r} {job.status}: {job.error or 'it has no proposal to apply'}"
            )
        raise _SoundsApplyError(
            409, f"job {job_id!r} is {job.status}; wait for it to finish"
        )
    ops = job.changeset.ops if job.changeset is not None else []
    items = _sounds_coerce_items(ops, f"job {job_id!r}")
    if not any(item.op in _SOUND_APPLY_OPS for item in items):
        raise _SoundsApplyError(400, f"job {job_id!r} has no sound items to apply")
    return items


def _sound_maybe(obj: Any, name: str, *args: Any) -> Any:
    if obj is None:
        return None
    method = getattr(obj, name, None)
    if method is None:
        return None
    return method(*args)


def _sound_snapshot_item(item: Any) -> dict[str, Any]:
    pool = _sound_maybe(item, "GetMediaPoolItem")
    file_path = _sound_maybe(pool, "GetClipProperty", "File Path")
    return {
        "unique_id": _sound_maybe(item, "GetUniqueId") or "",
        "name": _sound_maybe(item, "GetName") or "",
        "start": _sound_maybe(item, "GetStart"),
        "end": _sound_maybe(item, "GetEnd"),
        "source_start_frame": _sound_maybe(item, "GetSourceStartFrame"),
        "source_end_frame": _sound_maybe(item, "GetSourceEndFrame"),
        "file_path": file_path if isinstance(file_path, str) and file_path.strip() else None,
    }


def _sound_rate_label(timeline: Any, project: Any) -> str:
    """Frame-rate label off the timeline, else the project (mirrors the read path)."""
    for owner in (timeline, project):
        for key in ("timelineFrameRate", "timelinePlaybackFrameRate"):
            value = _sound_maybe(owner, "GetSetting", key)
            if isinstance(value, bool) or value is None:
                continue
            if isinstance(value, (int, float)):
                return str(value)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _sound_snapshot(project: Any, timeline: Any) -> dict[str, Any]:
    """Snapshot one timeline object for timeline_from_resolve. Read-only."""
    tracks = []
    for track_type in ("video", "audio", "subtitle"):
        count = int(_sound_maybe(timeline, "GetTrackCount", track_type) or 0)
        for index in range(1, count + 1):
            items = _sound_maybe(timeline, "GetItemListInTrack", track_type, index) or []
            tracks.append({
                "track_type": track_type,
                "index": index,
                "name": _sound_maybe(timeline, "GetTrackName", track_type, index) or "",
                "items": [
                    _sound_snapshot_item(item) for item in items if item is not None
                ],
            })
    return {
        "project_name": _sound_maybe(project, "GetName") or "",
        "name": _sound_maybe(timeline, "GetName") or "",
        "unique_id": _sound_maybe(timeline, "GetUniqueId") or "",
        "start_frame": _sound_maybe(timeline, "GetStartFrame"),
        "frame_rate": _sound_rate_label(timeline, project),
        "tracks": tracks,
        "markers": _sound_maybe(timeline, "GetMarkers") or {},
    }


def _free_copy_name(project: Any, original_name: str, label: str = "sound copy") -> str:
    """`<original> (<label>)`, with ` 2`, ` 3` while the name is taken."""
    taken: set[str] = set()
    count = project.GetTimelineCount() or 0
    for index in range(1, count + 1):
        candidate = project.GetTimelineByIndex(index)
        name = candidate.GetName() if candidate is not None else ""
        if name:
            taken.add(name)
    base = f"{original_name} ({label})"
    if base not in taken:
        return base
    suffix = 2
    while f"{base} {suffix}" in taken:
        suffix += 1
    return f"{base} {suffix}"


def _sounds_apply_body(body: dict[str, Any], controller: JobController) -> dict[str, Any]:
    """Apply sound items to Resolve as a NEW timeline; the original is untouched.

    Reads the named (or current) timeline, places the items with
    apply_sound_items, and writes `<original> (sound copy)` — which Resolve
    makes current. Ducking keyframes ride the manifest's Fairlight fallback.
    """
    job_id = body.get("jobId", "")
    if isinstance(job_id, str) and job_id.strip():
        items = _sounds_job_items(controller, job_id.strip())
    elif isinstance(body.get("items"), list) and body["items"]:
        items = _sounds_coerce_items(body["items"], "the request")
        if not any(item.op in _SOUND_APPLY_OPS for item in items):
            raise _SoundsApplyError(400, "the request holds no sound items to apply")
    else:
        raise _SoundsApplyError(
            400, "apply needs a finished 'jobId' or a non-empty 'items' list"
        )
    try:
        project, timeline_obj = _resolve_project_timeline(
            body.get("project"), body.get("timeline")
        )
    except _ResolveUnavailable as error:
        raise _SoundsApplyError(503, str(error)) from error
    except _ResolveFailed as error:
        raise _SoundsApplyError(502, str(error)) from error
    try:
        from chair_resolve.read import timeline_from_resolve
        from chair_resolve.write import apply_sound_items, write_timeline
    except ImportError as error:
        raise _SoundsApplyError(
            503, f"chair-adapter-resolve is not importable ({error})"
        ) from error
    try:
        timeline = timeline_from_resolve(_sound_snapshot(project, timeline_obj))
    except Exception as error:
        raise _SoundsApplyError(
            502, f"reading the Resolve timeline failed: {error}"
        ) from error
    original_name = str(timeline.get("name") or "")
    skipped: list[dict[str, str]] = []
    sound: list[dict[str, Any]] = []
    for item in items:
        if item.op in _SOUND_APPLY_OPS:
            sound.append(item.model_dump(mode="json", by_alias=True))
        else:
            skipped.append({
                "intent": item.id,
                "reason": f"the sound writer does not place {item.op} items",
            })
    try:
        copy, report = apply_sound_items(timeline, sound)
    except Exception as error:
        raise _SoundsApplyError(502, f"placing the sound failed: {error}") from error
    tracks_added = report.get("tracks_added") or []
    clips_placed = report.get("clips_placed") or []
    keyframes = report.get("keyframes") or 0
    for entry in report.get("skipped") or []:
        skipped.append({
            "intent": str(entry.get("id") or "?"),
            "reason": str(entry.get("reason") or "skipped"),
        })
    if not tracks_added and not clips_placed and not keyframes:
        reasons = "; ".join(entry["reason"] for entry in skipped) or "nothing could be placed"
        raise _SoundsApplyError(502, f"Resolve added nothing: {reasons}")
    try:
        copy["name"] = _free_copy_name(project, original_name)
    except Exception as error:
        raise _SoundsApplyError(
            502, f"listing the Resolve timelines failed: {error}"
        ) from error
    try:
        write_timeline(copy)
    except Exception as error:
        raise _SoundsApplyError(502, f"writing the Resolve copy failed: {error}") from error
    fallbacks = report.get("fallbacks") or []
    fallback = fallbacks[0].get("reason") if fallbacks else None
    return {
        "timeline_name": copy["name"],
        "original_timeline": original_name,
        "tracks_added": len(tracks_added),
        "clips_added": len(clips_placed),
        "skipped": skipped,
        "fallback": str(fallback) if fallback else None,
    }


def _sounds_undo_body(body: dict[str, Any]) -> dict[str, Any]:
    """Undo a sound apply: the original becomes current again, and the copy
    is deleted only when delete_copy is true. The original's contents are
    never touched."""
    copy_name = body.get("timeline_name", "")
    if not isinstance(copy_name, str) or not copy_name.strip():
        raise _SoundsApplyError(400, "undo needs the copy 'timeline_name'")
    original_name = body.get("original_timeline", "")
    if not isinstance(original_name, str) or not original_name.strip():
        raise _SoundsApplyError(400, "undo needs the 'original_timeline' to restore")
    delete_copy = body.get("delete_copy", False)
    if not isinstance(delete_copy, bool):
        raise _SoundsApplyError(400, "undo 'delete_copy' must be true or false")
    copy_name = copy_name.strip()
    original_name = original_name.strip()
    if delete_copy and copy_name == original_name:
        raise _SoundsApplyError(400, "undo refuses to delete the original timeline")
    try:
        project = _resolve_project(body.get("project"))
    except _ResolveUnavailable as error:
        raise _SoundsApplyError(503, str(error)) from error
    except _ResolveFailed as error:
        raise _SoundsApplyError(502, str(error)) from error
    try:
        original = _find_timeline_by_name(project, original_name)
        if original is None:
            raise _SoundsApplyError(
                502, f"Timeline {original_name!r} is not in this project."
            )
        if not project.SetCurrentTimeline(original):
            raise _SoundsApplyError(
                502, f"Resolve would not switch back to {original_name!r}."
            )
        deleted = False
        if delete_copy:
            copy_obj = _find_timeline_by_name(project, copy_name)
            if copy_obj is not None:
                media_pool = project.GetMediaPool()
                delete = (
                    getattr(media_pool, "DeleteTimelines", None)
                    if media_pool is not None else None
                )
                if not callable(delete):
                    raise _SoundsApplyError(
                        502,
                        "this Resolve cannot delete timelines by script; "
                        "delete the copy by hand",
                    )
                if not delete([copy_obj]):
                    raise _SoundsApplyError(
                        502, f"Resolve would not delete {copy_name!r}."
                    )
                deleted = True
    except _SoundsApplyError:
        raise
    except Exception as error:
        raise _SoundsApplyError(502, f"Resolve scripting failed: {error}") from error
    return {"current_timeline": original_name, "deleted": deleted}


_CUT_APPLY_OPS = frozenset({
    "trim", "move", "ripple", "remove_clip", "add_clip",
    "add_track", "remove_track", "add_marker", "remove_marker",
})

# Ops the writer answers itself: supported ones land, the rest skip with
# their manifest fallback (or the Piece Maker pointer for effects).
_CUT_WRITER_OPS = _CUT_APPLY_OPS | frozenset({
    "set_speed", "add_transition", "remove_transition",
    "add_effect", "remove_effect", "set_gain", "mute_clip",
})

_CUT_REPORT_COUNTS = (
    ("tracks_added", "tracks_added"),
    ("tracks_removed", "tracks_removed"),
    ("clips_placed", "clips_added"),
    ("clips_removed", "clips_removed"),
    ("clips_changed", "clips_changed"),
    ("markers_added", "markers_added"),
    ("markers_removed", "markers_removed"),
)


class _CutsApplyError(Exception):
    """A /cuts/apply or /cuts/undo failure: status plus one plain sentence."""

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        super().__init__(message)


def _cuts_job_items(controller: JobController, job_id: str) -> list[Any]:
    """A finished job's proposal. Raises _CutsApplyError when it cannot apply."""
    try:
        job = controller.get(job_id)
    except JobNotFound:
        raise _CutsApplyError(404, f"job {job_id!r} is unknown") from None
    if job.status != "completed":
        if job.status in ("failed", "moderated", "canceled"):
            raise _CutsApplyError(
                400, f"job {job_id!r} {job.status}: {job.error or 'it has no proposal to apply'}"
            )
        raise _CutsApplyError(
            409, f"job {job_id!r} is {job.status}; wait for it to finish"
        )
    ops = job.changeset.ops if job.changeset is not None else []
    items = _sounds_coerce_items(ops, f"job {job_id!r}")
    if not any(item.op in _CUT_APPLY_OPS for item in items):
        raise _CutsApplyError(400, f"job {job_id!r} has no cut items to apply")
    return items


def _cuts_apply_body(body: dict[str, Any], controller: JobController) -> dict[str, Any]:
    """Apply cut items to Resolve as a NEW timeline; the original is untouched.

    Reads the named (or current) timeline, reshapes it with
    apply_cut_items, and writes `<original> (cut copy)` — which Resolve
    makes current. Anything the cut writer cannot place skips with a
    reason, never silently.
    """
    import time as _time

    from chair_agent import cuts

    started = _time.perf_counter()
    job_id = body.get("jobId", "")
    if isinstance(job_id, str) and job_id.strip():
        items = _cuts_job_items(controller, job_id.strip())
    elif isinstance(body.get("items"), list) and body["items"]:
        items = _sounds_coerce_items(body["items"], "the request")
        if not any(item.op in _CUT_APPLY_OPS for item in items):
            raise _CutsApplyError(400, "the request holds no cut items to apply")
    else:
        raise _CutsApplyError(
            400, "apply needs a finished 'jobId' or a non-empty 'items' list"
        )
    try:
        project, timeline_obj = _resolve_project_timeline(
            body.get("project"), body.get("timeline")
        )
    except _ResolveUnavailable as error:
        raise _CutsApplyError(503, str(error)) from error
    except _ResolveFailed as error:
        raise _CutsApplyError(502, str(error)) from error
    try:
        from chair_resolve.cut_apply import apply_cut_items
        from chair_resolve.read import timeline_from_resolve
        from chair_resolve.write import write_timeline
    except ImportError as error:
        raise _CutsApplyError(
            503, f"chair-adapter-resolve is not importable ({error})"
        ) from error
    try:
        timeline = timeline_from_resolve(_sound_snapshot(project, timeline_obj))
    except Exception as error:
        raise _CutsApplyError(
            502, f"reading the Resolve timeline failed: {error}"
        ) from error
    original_name = str(timeline.get("name") or "")
    skipped: list[dict[str, str]] = []
    cut: list[dict[str, Any]] = []
    for item in items:
        if item.op in _CUT_WRITER_OPS:
            cut.append(item.model_dump(mode="json", by_alias=True))
        else:
            skipped.append({
                "intent": item.id,
                "reason": f"the cut writer does not place {item.op} items",
            })
    try:
        copy, report = apply_cut_items(timeline, cut)
    except Exception as error:
        raise _CutsApplyError(502, f"placing the cuts failed: {error}") from error
    counts = {out: len(report.get(key) or []) for key, out in _CUT_REPORT_COUNTS}
    for entry in report.get("skipped") or []:
        skipped.append({
            "intent": str(entry.get("id") or "?"),
            "reason": str(entry.get("reason") or "skipped"),
        })
    if not any(counts.values()):
        reasons = "; ".join(entry["reason"] for entry in skipped) or "nothing could be placed"
        raise _CutsApplyError(502, f"Resolve added nothing: {reasons}")
    try:
        copy["name"] = _free_copy_name(project, original_name, "cut copy")
    except Exception as error:
        raise _CutsApplyError(
            502, f"listing the Resolve timelines failed: {error}"
        ) from error
    try:
        write_timeline(copy)
    except Exception as error:
        raise _CutsApplyError(502, f"writing the Resolve copy failed: {error}") from error
    fallbacks = report.get("fallbacks") or []
    fallback = fallbacks[0].get("reason") if fallbacks else None
    cuts.note_applied(
        skipped_ops=len(skipped),
        write_ms=round((_time.perf_counter() - started) * 1000, 1),
    )
    return {
        "timeline_name": copy["name"],
        "original_timeline": original_name,
        **counts,
        "skipped": skipped,
        "fallback": str(fallback) if fallback else None,
    }


def _cuts_undo_body(body: dict[str, Any]) -> dict[str, Any]:
    """Undo a cut apply: the original becomes current again, and the copy
    is deleted only when delete_copy is true. The original's contents are
    never touched."""
    from chair_resolve.cut_apply import undo_copy_write

    from chair_agent import cuts

    try:
        project = _resolve_project(body.get("project"))
    except _ResolveUnavailable as error:
        raise _CutsApplyError(503, str(error)) from error
    except _ResolveFailed as error:
        raise _CutsApplyError(502, str(error)) from error
    try:
        undone = undo_copy_write(
            project,
            body.get("timeline_name", ""),
            body.get("original_timeline", ""),
            body.get("delete_copy", False),
        )
    except ValueError as error:
        raise _CutsApplyError(400, str(error)) from error
    except RuntimeError as error:
        raise _CutsApplyError(502, str(error)) from error
    except Exception as error:
        raise _CutsApplyError(502, f"Resolve scripting failed: {error}") from error
    cuts.note_undone()
    return undone


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
