import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cutroom_agent.models import TOOLS


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        body = json.dumps(
            {
                "service": "agent",
                "ok": True,
                "tools": [tool.model_dump() for tool in TOOLS],
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def main() -> None:
    host = os.environ.get("CUTROOM_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("CUTROOM_AGENT_PORT", "8787"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"cutroom-agent listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
