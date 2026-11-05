import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pydantic import ValidationError

from chair_sidecar.jobs import (
    FFMPEG_TOOLS,
    MODEL_TOOLS,
    MUSIC_TOOLS,
    SYNTH_TOOLS,
    JobKind,
    JobStore,
    MediaRequest,
    MusicRequest,
    Sam3Request,
    SamAudioRequest,
    SynthRequest,
    TapeStopRequest,
    default_proxy_dir,
    sam3_runner,
    sam_audio_runner,
)

DEFAULT_ALLOWED_ORIGINS: frozenset[str] = frozenset({
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    "http://tauri.localhost",
})


def allowed_origins() -> set[str]:
    raw = os.environ.get("CHAIR_ALLOWED_ORIGINS")
    if raw is None or not raw.strip():
        return set(DEFAULT_ALLOWED_ORIGINS)
    return {origin.strip() for origin in raw.split(",") if origin.strip()}


class SidecarServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], store: JobStore) -> None:
        self.store = store
        super().__init__(server_address, Handler)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(
                200,
                {
                    "service": "sidecar",
                    "ok": True,
                    "device": os.environ.get("CHAIR_SIDECAR_DEVICE", "cpu"),
                    "jobs": [kind.value for kind in JobKind],
                    "sam3_runner": sam3_runner() is not None,
                    "sam_audio_runner": sam_audio_runner() is not None,
                },
            )
            return
        if self.path.startswith("/jobs/"):
            job_id = self.path.removeprefix("/jobs/")
            if not job_id or "/" in job_id:
                self._json(404, {"error": "job not found"})
                return
            job = self._store().get(job_id)
            if job is None:
                self._json(404, {"error": "job not found"})
                return
            self._json(200, job)
            return
        self.send_error(404)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("origin")
        if not origin or origin not in allowed_origins():
            self.send_error(403)
            return
        self.send_response(204)
        self.send_header("access-control-allow-origin", origin)
        self.send_header("vary", "Origin")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()

    def do_POST(self) -> None:
        prefix = "/jobs/"
        if not self.path.startswith(prefix):
            self.send_error(404)
            return
        content_type = self.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type != "application/json":
            self._json(415, {"error": "content-type must be application/json"})
            return
        tool = self.path.removeprefix(prefix)
        if (
            tool not in FFMPEG_TOOLS
            and tool not in MODEL_TOOLS
            and tool not in MUSIC_TOOLS
            and tool not in SYNTH_TOOLS
        ):
            self._json(404, {"error": "unknown tool"})
            return
        if tool == "sam_audio":
            model = SamAudioRequest
        elif tool in MODEL_TOOLS:
            model = Sam3Request
        elif tool in MUSIC_TOOLS:
            model = MusicRequest
        elif tool == "synth_sfx":
            model = SynthRequest
        elif tool == "tape_stop":
            model = TapeStopRequest
        else:
            model = MediaRequest
        try:
            request = model.model_validate(self._payload())
            job = self._store().submit(tool, request)
        except json.JSONDecodeError:
            self._json(400, {"error": "body must be json"})
            return
        except ValidationError as exc:
            self._json(400, {"error": _validation_message(exc)})
            return
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        self._json(202, job)

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _store(self) -> JobStore:
        server = self.server
        if not isinstance(server, SidecarServer):
            raise RuntimeError("sidecar server is not configured")
        return server.store

    def _payload(self) -> object:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ValueError("missing body")
        length = int(raw_length)
        if length < 0 or length > 1_000_000:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length) or b"null")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        origin = self.headers.get("origin")
        if origin and origin in allowed_origins():
            self.send_header("access-control-allow-origin", origin)
        self.send_header("vary", "Origin")
        self.end_headers()
        self.wfile.write(body)


def _validation_message(exc: ValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(item) for item in err["loc"])
        parts.append(f"{loc}: {err['msg']}" if loc else err["msg"])
    return "; ".join(parts)


def main() -> None:
    host = os.environ.get("CHAIR_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("CHAIR_SIDECAR_PORT", "8788"))
    server = SidecarServer((host, port), JobStore(default_proxy_dir()))
    print(f"chair-sidecar listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
