"""Effect Maker brain: generate, target pick, verify loop, HTTP, health (#233)."""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from chair_agent import effects
from chair_agent.__main__ import Handler
from chair_agent.client import Completion
from chair_agent.effects import InvalidEffect


def _spec(**overrides):
    base = {
        "schemaVersion": "0.1.0",
        "id": "draft-1",
        "name": "Rising title",
        "durationSec": 3.0,
        "fps": 30,
        "width": 1920,
        "height": 1080,
        "layers": [
            {
                "id": "title",
                "type": "text",
                "params": {"string": "Hello", "font": "sans-serif",
                           "size": 96, "fill": "#ffffff"},
                "curves": {"opacity": {"keyframes": [
                    {"time": 0, "value": 0, "easing": "easeOut"},
                    {"time": 0.6, "value": 1},
                ]}},
            },
        ],
    }
    base.update(overrides)
    return base


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(Path(__file__).resolve().parents[3]))
    effects._EFFECTS.clear()
    effects._STATUS.update({
        "generated": 0, "verify_passes": 0, "verify_fails": 0,
        "last_latency_ms": None, "last_error": None,
    })
    return tmp_path


class FakeClient:
    """Mocked Muse Spark: queued execute/verify completion texts."""

    def __init__(self, execute=(), verify=()):
        self.execute_texts = list(execute)
        self.verify_texts = list(verify)
        self.execute_calls = 0
        self.verify_calls = 0
        self.last_messages = None

    def execute(self, messages):
        self.execute_calls += 1
        self.last_messages = messages
        return Completion(model="muse-spark-1", text=self.execute_texts.pop(0))

    def verify(self, messages):
        self.verify_calls += 1
        self.last_messages = messages
        return Completion(model="muse-spark-1", text=self.verify_texts.pop(0))


def _png_data_url() -> str:
    tiny = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
            "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    return f"data:image/png;base64,{tiny}"


def test_generate_valid_spec_targets_fusion_macro(isolated) -> None:
    client = FakeClient(execute=[json.dumps(_spec())])
    record = effects.generate_effect(
        "bouncing title over dark backdrop", width=1920, height=1080,
        fps=30, duration_sec=3.0, client=client,
    )
    assert record.id.startswith("fx-")
    assert record.spec["id"] == record.id
    assert record.spec["width"] == 1920
    assert record.spec["export"] == {"target": "fusion-macro"}
    assert "Muse Spark" in record.notes
    assert client.execute_calls == 1
    # Prompt craft: schema, taste guide, and canvas reach the model.
    developer = next(m.content for m in client.last_messages if m.role == "developer")
    assert "schemaVersion" in developer and "overshoot" in developer
    assert "1920x1080" in developer
    snapshot = effects.status_snapshot()
    assert snapshot["generated"] == 1
    assert snapshot["last_error"] is None
    assert isinstance(snapshot["last_latency_ms"], float)
    # Stored: get returns the same spec, and it survives a cache clear via disk.
    assert effects.get_effect(record.id).spec == record.spec
    effects._EFFECTS.clear()
    assert effects.get_effect(record.id).spec["name"] == "Rising title"


def test_generate_repairs_once_then_fails_clearly(isolated) -> None:
    bad = _spec()
    del bad["layers"]
    client = FakeClient(execute=[json.dumps(bad), json.dumps(_spec())])
    record = effects.generate_effect(
        "title", width=1280, height=720, fps=30, duration_sec=2.0, client=client,
    )
    assert client.execute_calls == 2
    assert "repaired on retry" in record.notes
    assert record.spec["layers"]

    always_bad = FakeClient(execute=[json.dumps(bad), json.dumps(bad)])
    with pytest.raises(InvalidEffect, match="failed validation twice"):
        effects.generate_effect(
            "title", width=1280, height=720, fps=30, duration_sec=2.0,
            client=always_bad,
        )
    assert effects.status_snapshot()["generated"] == 1
    assert "twice" in (effects.status_snapshot()["last_error"] or "")


def test_generate_repairs_malformed_json_once(isolated) -> None:
    # Live run had one stray "}" in a long reply; the repair round gets the
    # raw text plus the parse error, and at most one repair call happens.
    broken = json.dumps(_spec()) + "}"
    client = FakeClient(execute=[broken, json.dumps(_spec())])
    record = effects.generate_effect(
        "title", width=1280, height=720, fps=30, duration_sec=2.0, client=client,
    )
    assert client.execute_calls == 2
    assert "repaired on retry" in record.notes
    assert record.spec["layers"]
    developer = next(m.content for m in client.last_messages if m.role == "developer")
    assert "did not return JSON" in developer
    user = next(m.content for m in client.last_messages if m.role == "user")
    assert user == broken

    still_broken = FakeClient(execute=[broken, broken])
    with pytest.raises(InvalidEffect, match="did not return JSON"):
        effects.generate_effect(
            "title", width=1280, height=720, fps=30, duration_sec=2.0,
            client=still_broken,
        )
    assert still_broken.execute_calls == 2


def test_generate_shader_layers_ship_as_ograf_titles(isolated) -> None:
    spec = _spec(layers=[{"id": "glow", "type": "shader", "params": {}}],
                shader={"source": "void main(){}"})
    record = effects.generate_effect(
        "glowy shader wash", width=1920, height=1080, fps=30, duration_sec=2.0,
        client=FakeClient(execute=[json.dumps(spec)]),
    )
    assert record.spec["export"]["target"] == "ograf"
    fallback = record.spec["export"]["fallback"]
    assert fallback["capability"] == "native Fusion nodes"
    assert "shader" in fallback["reason"]
    assert "OGraf" in fallback["reason"]


def test_verify_pass_fail_revise_and_round_limit(isolated) -> None:
    record = effects.generate_effect(
        "title", width=1920, height=1080, fps=30, duration_sec=3.0,
        client=FakeClient(execute=[json.dumps(_spec())]),
    )
    fixed = _spec(name="Rising title (fixed)")
    client = FakeClient(verify=[
        json.dumps({"pass": True, "notes": "Matches the brief.", "revisedSpec": None}),
        json.dumps({"pass": False, "notes": ["Text sits too low."],
                    "revisedSpec": fixed}),
        json.dumps({"pass": False, "notes": ["Still low."], "revisedSpec": fixed}),
    ])
    png = _png_data_url()
    same, passed, notes = effects.verify_effect(
        record.id, preview_png=png, client=client,
    )
    assert passed and same.verify_rounds == 1
    assert same.last_verdict == "pass"

    revised, passed, notes = effects.verify_effect(
        record.id, preview_png=png, reference_png=png, client=client,
    )
    assert not passed and revised.spec["name"] == "Rising title (fixed)"
    assert revised.spec["id"] == record.id
    assert revised.verify_rounds == 2
    assert effects.status_snapshot()["verify_passes"] == 1
    assert effects.status_snapshot()["verify_fails"] == 1

    with pytest.raises(InvalidEffect, match="2 verify rounds"):
        effects.verify_effect(record.id, preview_png=png, client=client)


def test_verify_rejects_non_json_and_unknown_ids(isolated) -> None:
    record = effects.generate_effect(
        "title", width=1920, height=1080, fps=30, duration_sec=3.0,
        client=FakeClient(execute=[json.dumps(_spec())]),
    )
    with pytest.raises(InvalidEffect, match="previewPng"):
        effects.verify_effect(record.id, preview_png=" ",
                              client=FakeClient(verify=[]))
    with pytest.raises(InvalidEffect, match="unknown effect"):
        effects.verify_effect("fx-nope", preview_png=_png_data_url(),
                              client=FakeClient(verify=[]))
    with pytest.raises(InvalidEffect, match="non-empty 'prompt'"):
        effects.generate_effect(" ", width=1920, height=1080, fps=30,
                                duration_sec=3.0,
                                client=FakeClient(execute=[]))


def test_http_generate_get_verify_and_health(isolated) -> None:
    client = FakeClient(
        execute=[json.dumps(_spec())],
        verify=[json.dumps({"pass": True, "notes": "Matches.", "revisedSpec": None})],
    )
    from chair_agent import client as client_module

    monkeypatch_client = pytest.MonkeyPatch()
    monkeypatch_client.setattr(
        "chair_agent.effects._model_client", lambda role: client,
    )
    monkeypatch_client.setattr(
        "chair_agent.client.load_settings",
        lambda env=None: client_module.Settings(
            models=client_module.RoleModels(
                planner="muse-wonder-1.0", executor="muse-spark-1",
                verifier="muse-spark-1"),
            base_url="https://api.meta.ai/v1", api_key="test-key"),
    )
    monkeypatch_client.setattr(
        "chair_agent.client.build_client", lambda env=None: client,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        generate = Request(
            f"http://127.0.0.1:{port}/effects/generate",
            data=json.dumps({
                "prompt": "rising title",
                "canvas": {"width": 1920, "height": 1080},
                "fps": 30, "durationSec": 3.0,
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(generate) as response:
            created = json.load(response)
        assert created["spec"]["export"] == {"target": "fusion-macro"}
        assert created["id"] == created["spec"]["id"]

        with urlopen(f"http://127.0.0.1:{port}/effects/{created['id']}") as response:
            fetched = json.load(response)
        assert fetched["spec"] == created["spec"]

        check = Request(
            f"http://127.0.0.1:{port}/effects/{created['id']}/verify",
            data=json.dumps({"previewPng": _png_data_url()}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(check) as response:
            verdict = json.load(response)
        assert verdict == {"pass": True, "notes": "Matches."}

        with urlopen(f"http://127.0.0.1:{port}/health") as response:
            health = json.load(response)
        assert health["effects"]["generated"] == 1
        assert health["effects"]["verify_passes"] == 1
        assert health["effects"]["verify_fails"] == 0
        assert health["effects"]["last_error"] is None
    finally:
        monkeypatch_client.undo()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
