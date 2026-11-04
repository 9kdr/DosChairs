import json
import threading
from collections.abc import Callable
from http.server import ThreadingHTTPServer
from urllib.request import urlopen

import httpx
import pytest
from chair_agent.__main__ import Handler
from chair_agent.client import (
    Completion,
    HttpxTransport,
    Message,
    ModelClient,
    ModelNotConfigured,
    RoleModels,
    UnexpectedResponse,
    build_brief_planner_messages,
    build_client,
    build_planner_messages,
    configured_models,
)
from chair_agent.pieces import search_pieces

HandlerFn = Callable[[httpx.Request], httpx.Response]


def _client(handler: HandlerFn, *, api_key: str | None, models: RoleModels) -> ModelClient:
    return ModelClient(
        models=models,
        transport=HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
        api_key=api_key,
    )


def _models() -> RoleModels:
    return RoleModels(
        planner="muse-wonder-1.0",
        executor="muse-spark-1",
        verifier="muse-spark-1",
    )


def test_planner_executor_and_verifier_share_one_client() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}]})

    client = _client(handler, api_key="test-key", models=_models())
    user = Message(role="user", content="plan")
    assert client.plan([user]) == Completion(model="muse-wonder-1.0", text="done")
    assert client.execute([Message(role="user", content="cut")]) == Completion(
        model="muse-spark-1",
        text="done",
    )
    assert client.verify([Message(role="user", content="check")]) == Completion(
        model="muse-spark-1",
        text="done",
    )

    bodies = [json.loads(request.content) for request in seen]
    assert [request.url.path for request in seen] == ["/v1/chat/completions"] * 3
    assert [body["model"] for body in bodies] == ["muse-wonder-1.0", "muse-spark-1", "muse-spark-1"]
    assert [body["messages"][0]["content"] for body in bodies] == ["plan", "cut", "check"]
    assert all(request.headers["authorization"] == "Bearer test-key" for request in seen)


def test_max_tokens_sent_only_when_set() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}]})

    plain = _client(handler, api_key="test-key", models=_models())
    plain.execute([Message(role="user", content="cut")])
    assert "max_tokens" not in json.loads(seen[-1].content)

    roomy = ModelClient(
        models=_models(),
        transport=HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
        api_key="test-key",
        max_tokens=8000,
    )
    roomy.execute([Message(role="user", content="cut")])
    assert json.loads(seen[-1].content)["max_tokens"] == 8000


def test_missing_model_does_not_call() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(request.url)

    client = _client(
        handler,
        api_key="test-key",
        models=RoleModels(planner=None, executor="muse-spark-1", verifier="muse-spark-1"),
    )
    with pytest.raises(ModelNotConfigured) as raised:
        client.plan([Message(role="user", content="plan")])
    assert raised.value.role == "planner"


def test_blank_key_omits_authorization() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}]})

    client = _client(handler, api_key=None, models=_models())
    assert client.execute([Message(role="user", content="cut")]).text == "done"


def test_unexpected_completion_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    client = _client(handler, api_key=None, models=_models())
    with pytest.raises(UnexpectedResponse):
        client.verify([Message(role="user", content="check")])


def test_configured_models_reports_only_set_names() -> None:
    assert configured_models({}) == {"planner": None, "executor": None, "verifier": None}
    assert configured_models(
        {
            "CHAIR_PLANNER_MODEL": " muse-wonder-1.0 ",
            "CHAIR_EXECUTOR_MODEL": "",
            "CHAIR_VERIFIER_MODEL": "muse-spark-1",
        }
    ) == {
        "planner": "muse-wonder-1.0",
        "executor": None,
        "verifier": "muse-spark-1",
    }


def test_build_client_reads_env_names() -> None:
    client = build_client(
        {
            "META_API_BASE_URL": "https://example.test/v1/",
            "META_API_KEY": "test-key",
            "CHAIR_PLANNER_MODEL": "muse-wonder-1.0",
            "CHAIR_EXECUTOR_MODEL": "muse-spark-1",
            "CHAIR_VERIFIER_MODEL": "muse-spark-1",
        }
    )
    assert isinstance(client.transport, HttpxTransport)
    assert client.transport.base_url == "https://example.test/v1"
    assert client.models.planner == "muse-wonder-1.0"
    assert client.models.executor == "muse-spark-1"
    assert client.models.verifier == "muse-spark-1"


def test_planner_prompt_carries_pieces_refs_and_defaults() -> None:
    messages = build_planner_messages("Cut a 60 s teaser", search_pieces(effect="motion_graphics"))
    assert [message.role for message in messages] == ["developer", "user"]
    assert "kinetic-title" in messages[0].content
    assert "music bed with beat grid" in messages[0].content
    assert "template=lower-third" in messages[0].content
    with pytest.raises(ValueError):
        build_planner_messages("  ", search_pieces())


def test_brief_planner_prompt_carries_tool_registry() -> None:
    messages = build_brief_planner_messages("Cut pauses and add warm grade")
    assert [message.role for message in messages] == ["developer", "user"]
    assert "measure_audio" in messages[0].content
    assert "render_preview" in messages[0].content
    assert "editor_op" in messages[0].content
    assert "tape_stop_outro" in messages[0].content
    assert messages[1].content == "Cut pauses and add warm grade"
    with pytest.raises(ValueError):
        build_brief_planner_messages("  ")


def test_health_reports_configured_model_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHAIR_PLANNER_MODEL", "muse-wonder-1.0")
    monkeypatch.setenv("CHAIR_EXECUTOR_MODEL", "muse-spark-1")
    monkeypatch.setenv("CHAIR_VERIFIER_MODEL", "muse-spark-1")
    monkeypatch.setenv("META_API_KEY", "test-key")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            body = json.load(response)
            allow_origin = response.headers.get("Access-Control-Allow-Origin")
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

    assert allow_origin == "*"
    assert body["service"] == "agent"
    assert body["ok"] is True
    assert body["models"] == {
        "planner": "muse-wonder-1.0",
        "executor": "muse-spark-1",
        "verifier": "muse-spark-1",
    }
    assert "test-key" not in json.dumps(body)
    assert body["key_configured"] is True
    assert any(tool["name"] == "render_preview" for tool in body["tools"])


def test_health_pipeline_reports_jobs_plan_and_repairs(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from chair_agent import planner
    from chair_agent.jobs import JobController

    monkeypatch.setattr(
        planner, "_STATUS", {"plans": 0, "last_plan_ms": None, "last_error": None}
    )
    controller = JobController(
        tmp_path / "jobs.json", deliver=lambda url, body, headers: None
    )
    old = getattr(Handler, "controller", None)
    Handler.controller = controller
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        done = controller.submit("edit", {"brief": "cut the silence"})
        controller.claim_next()
        controller.finish_completed(done.request_id)
        bad = controller.submit("edit", {"brief": "cut the silence"})
        controller.claim_next()
        controller.finish_failed(bad.request_id, "boom")
        planner.plan_brief("cut the silence from the proxy", env={})
        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            body = json.load(response)
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
        if old is None:
            del Handler.controller
        else:
            Handler.controller = old

    pipeline = body["pipeline"]
    assert pipeline == {
        "jobs_queued": 0,
        "jobs_done": 1,
        "jobs_failed": 1,
        "last_error": "boom",
        "last_plan_ms": pipeline["last_plan_ms"],
        "effect_repairs_used": pipeline["effect_repairs_used"],
    }
    assert isinstance(pipeline["last_plan_ms"], float)
    assert isinstance(pipeline["effect_repairs_used"], int)


def test_plan_brief_records_timing_and_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    from chair_agent import planner

    monkeypatch.setattr(
        planner, "_STATUS", {"plans": 0, "last_plan_ms": None, "last_error": None}
    )
    planner.plan_brief("cut the silence", env={})
    snapshot = planner.status_snapshot()
    assert snapshot["plans"] == 1
    assert isinstance(snapshot["last_plan_ms"], float)
    assert snapshot["last_error"] is None
    with pytest.raises(ValueError):
        planner.plan_brief("make the look warmer with a grade", env={})
    assert planner.status_snapshot()["last_error"] is not None


def test_saved_key_endpoint_and_not_echoed(monkeypatch) -> None:
    from urllib.request import Request

    from chair_agent.__main__ import Handler
    from chair_agent.client import _MEMORY_KEYS, set_key

    # Ensure clean memory keys
    _MEMORY_KEYS.clear()
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # Check initial health
        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            initial = json.load(response)
        assert initial["key_configured"] is False
        assert initial["keys_configured"] == {"meta": False, "openai": False, "anthropic": False}

        # POST a key to /keys
        secret_key = "test-secret-never-echoed-998877"
        req = Request(
            f"http://127.0.0.1:{port}/keys",
            data=json.dumps({"provider": "meta", "key": secret_key}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as response:
            post_resp = json.load(response)
            assert response.status == 200

        # Prove secret key is not in response
        assert secret_key not in json.dumps(post_resp)
        assert post_resp["ok"] is True
        assert post_resp["keys_configured"]["meta"] is True

        # Check /health reports key is configured but never echoes the key
        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            health_body = json.load(response)
        assert secret_key not in json.dumps(health_body)
        assert health_body["key_configured"] is True
        assert health_body["keys_configured"]["meta"] is True
        assert health_body["keys_configured"]["openai"] is False
        assert "last_auth_error" in health_body
        assert "last_auth_error_at" in health_body

        # Clear key
        set_key("meta", None)
        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            cleared_body = json.load(response)
        assert cleared_body["keys_configured"]["meta"] is False
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
        _MEMORY_KEYS.clear()


def test_model_selection_and_multi_provider() -> None:
    from chair_agent.client import (
        _MEMORY_KEYS,
        build_client_for_model,
        parse_model_selection,
        set_key,
    )

    _MEMORY_KEYS.clear()
    assert parse_model_selection("muse-wonder-1.0 (Meta)") == ("muse-wonder-1.0", "meta")
    assert parse_model_selection("gpt-4o (OpenAI)") == ("gpt-4o", "openai")
    assert parse_model_selection("claude-3-5-sonnet (Anthropic)") == (
        "claude-3-5-sonnet",
        "anthropic",
    )
    assert parse_model_selection("plain-model") == ("plain-model", "meta")

    # With no keys, build_client_for_model returns None
    assert build_client_for_model("muse-wonder-1.0 (Meta)", env={}) is None
    assert build_client_for_model("gpt-4o (OpenAI)", env={}) is None

    # Unsupported provider returns None even with key
    set_key("anthropic", "ant-key")
    assert build_client_for_model("claude-3-5-sonnet (Anthropic)", env={}) is None

    # With key set in memory:
    set_key("meta", "meta-secret")
    meta_client = build_client_for_model("muse-wonder-1.0 (Meta)", env={})
    assert meta_client is not None
    assert meta_client.models.planner == "muse-wonder-1.0"

    set_key("openai", "openai-secret")
    openai_client = build_client_for_model("gpt-4o (OpenAI)", env={})
    assert openai_client is not None
    assert openai_client.models.planner == "gpt-4o"
    assert "api.openai.com" in openai_client.transport.base_url
    _MEMORY_KEYS.clear()



def test_stale_key_reports_its_last_auth_error() -> None:
    from chair_agent import client as client_module

    def denied(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid key"})

    transport = HttpxTransport(
        "https://example.test/v1",
        client=httpx.Client(transport=httpx.MockTransport(denied)),
    )
    before = client_module.auth_status_snapshot()
    with pytest.raises(httpx.HTTPStatusError):
        transport.post_json("/chat/completions", {}, "stale-key")
    snapshot = client_module.auth_status_snapshot()
    assert snapshot["last_auth_error"] is not None
    assert "401" in snapshot["last_auth_error"]
    assert snapshot["last_auth_error_at"] is not None

    def missing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "no such path"})

    transport404 = HttpxTransport(
        "https://example.test/v1",
        client=httpx.Client(transport=httpx.MockTransport(missing)),
    )
    with pytest.raises(httpx.HTTPStatusError):
        transport404.post_json("/chat/completions", {}, "stale-key")
    # A 404 leaves the last auth error alone.
    assert client_module.auth_status_snapshot() == snapshot
    client_module._AUTH_STATUS.update(before)
