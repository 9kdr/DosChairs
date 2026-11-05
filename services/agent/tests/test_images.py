import json
from collections.abc import Callable

import httpx
import pytest
from chair_agent.client import HttpxTransport
from chair_agent.images import (
    GeneratedImage,
    HttpImageAdapter,
    ImageAdapter,
    UnexpectedImage,
    build_image_adapter,
)

HandlerFn = Callable[[httpx.Request], httpx.Response]


def _adapter(handler: HandlerFn, *, api_key: str | None = "test-key") -> HttpImageAdapter:
    return HttpImageAdapter(
        HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
        model="muse-image-1.0",
        api_key=api_key,
    )


def test_http_adapter_posts_generations_and_reads_the_image() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/images/generations"
        assert json.loads(request.content) == {
            "model": "muse-image-1.0",
            "prompt": "a fox",
            "n": 1,
        }
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"data": [{"url": "https://example.test/fox.png"}]})

    image = _adapter(handler).generate("a fox")
    assert image == GeneratedImage(
        prompt="a fox",
        model="muse-image-1.0",
        url="https://example.test/fox.png",
    )


def test_http_adapter_reads_inline_bytes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"b64_json": "abc"}]})

    image = _adapter(handler).generate("a fox")
    assert image.b64_json == "abc"
    assert image.url is None


def test_unexpected_image_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    with pytest.raises(UnexpectedImage):
        _adapter(handler).generate("a fox")


def test_image_adapter_can_be_swapped() -> None:
    class MemoryAdapter:
        def generate(self, prompt: str, *, size: str | None = None) -> GeneratedImage:
            assert size is None
            return GeneratedImage(prompt=prompt, model="memory", url="mem://fox")

    def run(adapter: ImageAdapter, prompt: str) -> GeneratedImage:
        return adapter.generate(prompt)

    swapped = run(MemoryAdapter(), "a fox")
    assert swapped.model == "memory"
    assert swapped.url == "mem://fox"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"url": "https://example.test/fox.png"}]})

    posted = run(_adapter(handler), "a fox")
    assert posted.model == "muse-image-1.0"
    assert posted.url == "https://example.test/fox.png"


def test_http_adapter_sends_size_when_given() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {
            "model": "muse-image-1.0",
            "prompt": "a fox",
            "n": 1,
            "size": "1792x1024",
        }
        return httpx.Response(200, json={"data": [{"b64_json": "abc"}]})

    image = _adapter(handler).generate("a fox", size="1792x1024")
    assert image.b64_json == "abc"


def test_counters_track_generations_and_failures() -> None:
    from chair_agent.images import note_generated, reset_status, status_snapshot

    reset_status()
    note_generated(latency_ms=12.5)
    snapshot = status_snapshot()
    assert snapshot["generated"] == 1
    assert snapshot["failed"] == 0
    assert snapshot["last_latency_ms"] == 12.5
    assert snapshot["last_error"] is None
    note_generated(latency_ms=3.0, error="RuntimeError: boom")
    snapshot = status_snapshot()
    assert snapshot["generated"] == 1
    assert snapshot["failed"] == 1
    assert snapshot["last_error"] == "RuntimeError: boom"
    reset_status()
    assert status_snapshot()["generated"] == 0


def test_failed_calls_count_and_reraise() -> None:
    from chair_agent.images import reset_status, status_snapshot

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    reset_status()
    with pytest.raises(UnexpectedImage):
        _adapter(handler).generate("a fox")
    snapshot = status_snapshot()
    assert snapshot["failed"] == 1
    assert snapshot["generated"] == 0
    assert snapshot["last_error"] is not None
    reset_status()


def test_build_image_adapter_uses_the_model_api_env() -> None:
    adapter = build_image_adapter(
        "muse-image-1.0",
        {"META_API_BASE_URL": "https://example.test/v1", "META_API_KEY": "test-key"},
    )
    assert isinstance(adapter, HttpImageAdapter)
    assert isinstance(adapter.transport, HttpxTransport)
    assert adapter.transport.base_url == "https://example.test/v1"
