import threading
import time
from collections.abc import Mapping
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from chair_agent.client import HttpxTransport, Transport, load_settings

MUSE_IMAGE_MODEL = "muse-image-1.0"

# The one landscape size verified against the live API (200); anything
# else stays the API default. The API takes no reference input
# ("unknown parameter `image`"), so multi-shot consistency travels in
# the prompt text (see skills/match-cut).
LANDSCAPE_SIZE = "1792x1024"


class GeneratedImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str
    model: str
    url: str | None = None
    b64_json: str | None = None


class UnexpectedImage(Exception):
    pass


class ImageAdapter(Protocol):
    def generate(
        self, prompt: str, *, size: str | None = None
    ) -> GeneratedImage: ...


class HttpImageAdapter:
    def __init__(self, transport: Transport, *, model: str, api_key: str | None) -> None:
        self.transport = transport
        self._model = model
        self._api_key = api_key

    def generate(self, prompt: str, *, size: str | None = None) -> GeneratedImage:
        started = time.perf_counter()
        try:
            payload = self.transport.post_json(
                "/images/generations",
                {
                    "model": self._model,
                    "prompt": prompt,
                    "n": 1,
                    **({"size": size} if size else {}),
                },
                self._api_key,
            )
            image = _generated(payload, prompt=prompt, model=self._model)
        except Exception as error:
            note_generated(
                latency_ms=round((time.perf_counter() - started) * 1000, 1),
                error=f"{type(error).__name__}: {error}",
            )
            raise
        note_generated(latency_ms=round((time.perf_counter() - started) * 1000, 1))
        return image


def build_image_adapter(model: str, env: Mapping[str, str] | None = None) -> HttpImageAdapter:
    settings = load_settings(env)
    return HttpImageAdapter(
        HttpxTransport(settings.base_url),
        model=model,
        api_key=settings.api_key,
    )


_LOCK = threading.Lock()
_STATUS: dict[str, Any] = {
    "generated": 0,
    "failed": 0,
    "last_error": None,
    "last_latency_ms": None,
}


def status_snapshot() -> dict[str, Any]:
    """Health counters: images generated/failed, last error, last ms."""
    with _LOCK:
        return dict(_STATUS)


def note_generated(*, latency_ms: float, error: str | None = None) -> None:
    """Note one generation: counts it, or records the failure."""
    with _LOCK:
        if error is None:
            _STATUS["generated"] += 1
        else:
            _STATUS["failed"] += 1
        _STATUS["last_latency_ms"] = latency_ms
        _STATUS["last_error"] = error


def reset_status() -> None:
    with _LOCK:
        _STATUS["generated"] = 0
        _STATUS["failed"] = 0
        _STATUS["last_error"] = None
        _STATUS["last_latency_ms"] = None


def _generated(payload: dict[str, Any], *, prompt: str, model: str) -> GeneratedImage:
    data = payload.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise UnexpectedImage
    item = data[0]
    url = item.get("url")
    b64_json = item.get("b64_json")
    url_value = url if isinstance(url, str) and url else None
    b64_value = b64_json if isinstance(b64_json, str) and b64_json else None
    if url_value is None and b64_value is None:
        raise UnexpectedImage
    return GeneratedImage(prompt=prompt, model=model, url=url_value, b64_json=b64_value)
