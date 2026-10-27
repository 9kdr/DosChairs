from collections.abc import Mapping
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from chair_agent.client import HttpxTransport, Transport, load_settings


class GeneratedImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str
    model: str
    url: str | None = None
    b64_json: str | None = None


class UnexpectedImage(Exception):
    pass


class ImageAdapter(Protocol):
    def generate(self, prompt: str) -> GeneratedImage: ...


class HttpImageAdapter:
    def __init__(self, transport: Transport, *, model: str, api_key: str | None) -> None:
        self.transport = transport
        self._model = model
        self._api_key = api_key

    def generate(self, prompt: str) -> GeneratedImage:
        payload = self.transport.post_json(
            "/images/generations",
            {"model": self._model, "prompt": prompt, "n": 1},
            self._api_key,
        )
        return _generated(payload, prompt=prompt, model=self._model)


def build_image_adapter(model: str, env: Mapping[str, str] | None = None) -> HttpImageAdapter:
    settings = load_settings(env)
    return HttpImageAdapter(
        HttpxTransport(settings.base_url),
        model=model,
        api_key=settings.api_key,
    )


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
