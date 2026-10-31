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
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

    assert body["service"] == "agent"
    assert body["ok"] is True
    assert body["models"] == {
        "planner": "muse-wonder-1.0",
        "executor": "muse-spark-1",
        "verifier": "muse-spark-1",
    }
    assert "test-key" not in json.dumps(body)
    assert any(tool["name"] == "render_preview" for tool in body["tools"])
