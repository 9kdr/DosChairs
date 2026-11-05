import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_agent.__main__ import DEFAULT_ALLOWED_ORIGINS, Handler
from chair_agent.jobs import JobController


@pytest.fixture
def agent_server(tmp_path: Path):
    Handler.controller = JobController(tmp_path / "jobs.json")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    yield base_url
    server.shutdown()
    thread.join(timeout=2.0)


def _request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    req = Request(url, headers=headers or {}, method=method)
    try:
        with urlopen(req) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, resp_headers, resp.read()
    except HTTPError as err:
        err_headers = {k.lower(): v for k, v in err.headers.items()}
        return err.code, err_headers, err.read()


@pytest.mark.parametrize("origin", DEFAULT_ALLOWED_ORIGINS)
def test_allowed_origin_echoed_and_vary_origin_present(agent_server: str, origin: str) -> None:
    # GET request with allowed origin
    status, headers, _ = _request(
        f"{agent_server}/health",
        headers={"Origin": origin},
    )
    assert status == 200
    assert headers.get("access-control-allow-origin") == origin
    assert headers.get("vary") == "Origin"

    # OPTIONS preflight with allowed origin
    status, headers, _ = _request(
        f"{agent_server}/jobs",
        method="OPTIONS",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert status == 204
    assert headers.get("access-control-allow-origin") == origin
    assert headers.get("vary") == "Origin"
    assert "content-type" in headers.get("access-control-allow-headers", "")


def test_foreign_origin_gets_no_allow_header_and_options_refused(agent_server: str) -> None:
    foreign = "http://evil.com"

    # GET request with foreign origin
    status, headers, _ = _request(
        f"{agent_server}/health",
        headers={"Origin": foreign},
    )
    assert status == 200
    assert "access-control-allow-origin" not in headers
    assert headers.get("vary") == "Origin"

    # OPTIONS preflight with foreign origin is refused (403)
    status, headers, body = _request(
        f"{agent_server}/jobs",
        method="OPTIONS",
        headers={
            "Origin": foreign,
            "Access-Control-Request-Method": "POST",
        },
    )
    assert status == 403
    assert "access-control-allow-origin" not in headers
    assert headers.get("vary") == "Origin"
    assert b"forbidden_origin" in body


def test_no_origin_request_works_normally(agent_server: str) -> None:
    # GET with no Origin header
    status, headers, body = _request(f"{agent_server}/health")
    assert status == 200
    assert "access-control-allow-origin" not in headers
    assert headers.get("vary") == "Origin"
    assert b'"ok": true' in body or b'"ok":true' in body

    # OPTIONS with no Origin header
    status, headers, _ = _request(f"{agent_server}/jobs", method="OPTIONS")
    assert status == 204
    assert "access-control-allow-origin" not in headers
    assert headers.get("vary") == "Origin"


def test_env_var_override_allowed_origins(
    agent_server: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    custom = "http://custom-app.local:3000"
    monkeypatch.setenv("CHAIR_ALLOWED_ORIGINS", f"{custom}, https://staging.chair.test")

    # Custom origin is now allowed
    status, headers, _ = _request(
        f"{agent_server}/health",
        headers={"Origin": custom},
    )
    assert status == 200
    assert headers.get("access-control-allow-origin") == custom

    # Default origin is no longer allowed when overridden
    default_origin = "http://localhost:1420"
    status, headers, _ = _request(
        f"{agent_server}/jobs",
        method="OPTIONS",
        headers={"Origin": default_origin},
    )
    assert status == 403
    assert "access-control-allow-origin" not in headers
