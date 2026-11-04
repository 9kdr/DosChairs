"""Piece plans: split, route native/reuse/new, adapt, guide, never fail (#278)."""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_agent import modules, piece_plan
from chair_agent.__main__ import Handler
from chair_agent.client import Completion
from chair_agent.modules import InvalidModule

ROOT = Path(__file__).resolve().parents[3]
TOOLCHAIN = (ROOT / "packages" / "effects" / "node_modules" / ".bin" / "esbuild").exists()
needs_toolchain = pytest.mark.skipif(not TOOLCHAIN, reason="run `mise run bootstrap` first")

PROOF = "a kinetic title saying LAUNCH over a liquid gradient with grain"

TEXT_SRC = """\
import React from "react";
export const meta = { id: "tiny-text", name: "Tiny Text", kind: "overlay",
  durationSec: 2, fps: 30, width: 640, height: 360 };
export const props = {
  size: { type: "number", min: 10, max: 100, default: 40, title: "Size" },
};
export default function Effect({ t, size }: any) {
  return <div style={{ position: "absolute", inset: 0, fontSize: size }}>Hello</div>;
}
"""


def fenced(code: str) -> str:
    return f"Here you go.\n```tsx\n{code}```\n"


class FakeClient:
    def __init__(self, texts):
        self.texts = list(texts)
        self.calls = 0
        self.last_messages = None
        self.models = type("M", (), {"executor": "muse-spark-1.3-contributor"})()

    def execute(self, messages):
        self.calls += 1
        self.last_messages = messages
        return Completion(model="muse-spark-1.3-contributor", text=self.texts.pop(0))


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(ROOT))
    monkeypatch.setenv("CHAIR_OGRAF_DIR", str(tmp_path / "ograf"))
    modules.reset_status()
    piece_plan.reset_status()
    return tmp_path


def ok_report(**extra):
    report = {
        "ok": True, "errors": [], "warnings": [],
        "meta": {"id": "tiny-text", "name": "Tiny Text"},
        "props": [{"id": "size"}], "checks": {"deterministic": True},
    }
    report.update(extra)
    return report


def test_proof_brief_plans_native_reuse_native() -> None:
    plan = piece_plan.plan_piece(PROOF)
    assert [(p.route, p.tool, p.piece_id) for p in plan.parts] == [
        ("native", "Text+", None),
        ("reuse", None, "mesh-gradient"),
        ("native", "FilmGrain", None),
    ]
    assert plan.parts[0].settings == {"text": "LAUNCH"}
    assert [p.order for p in plan.parts] == [0, 1, 2]
    assert (plan.counts.native, plan.counts.reuse, plan.counts.new) == (2, 1, 0)


@pytest.mark.parametrize(
    ("brief", "piece_id"),
    [
        ("smoothly merging liquid boxes", "liquid-boxes"),
        ("a liquid gradient", "mesh-gradient"),
        ("Dither title piece", "dither-reveal"),
        ("Make a dither title piece", "dither-reveal"),
        ("a morphing icon", "morph-icon"),
        ("A lower third for the host", "lower-third"),
    ],
)
def test_reuse_names_the_subject(brief: str, piece_id: str) -> None:
    plan = piece_plan.plan_piece(brief)
    assert len(plan.parts) == 1
    assert plan.parts[0].route == "reuse"
    assert plan.parts[0].piece_id == piece_id


@pytest.mark.parametrize(
    "brief",
    [
        "fade a label in",
        "fade",
        "dark title background with big words",
        "a bouncing logo",
        "Bouncy cursor",
        "a liquid haze",
        "Kinetic type: each letter of a short word hangs from a rope",
    ],
)
def test_single_element_briefs_stay_new_without_a_subject(brief: str) -> None:
    plan = piece_plan.plan_piece(brief)
    assert len(plan.parts) == 1
    assert plan.parts[0].route == "new"
    assert plan.parts[0].brief == brief


def test_eval_briefs_never_reroute() -> None:
    data = json.loads((ROOT / "services/agent/eval/modules_briefs.json").read_text())
    briefs = data.get("briefs", data if isinstance(data, list) else [])
    assert len(briefs) >= 10
    for entry in briefs:
        plan = piece_plan.plan_piece(entry["brief"])
        assert len(plan.parts) == 1, entry["id"]
        assert plan.parts[0].route == "new", entry["id"]


@pytest.mark.parametrize(
    ("brief", "count"),
    [
        ("grain and glow", 2),
        ("grain and glow over a gradient", 3),
        ("a blob that breathes over a dark background", 2),
        ("a morphing icon with glow", 2),
        ("A lower third for the host with film grain", 2),
        ("a title plus grain", 2),
        ("bounce and settle", 1),
        ("a ring drains over the duration while a number counts", 1),
        ("dark title background with big words", 1),
        ("a badge with a short label that chases a target", 1),
        ("a title saying A and B", 1),
    ],
)
def test_split_guards(brief: str, count: int) -> None:
    assert len(piece_plan.split_brief(brief)) == count, brief


def test_explicit_specs_and_literals_never_split() -> None:
    assert piece_plan.split_brief("a title over grain. Props: speed") == [
        "a title over grain. Props: speed"
    ]
    assert piece_plan.split_brief("a widget ```tsx code``` over grain") == [
        "a widget ```tsx code``` over grain"
    ]
    plan = piece_plan.plan_piece('a label reading "go live" over grain')
    assert [p.brief for p in plan.parts] == ['a label reading "go live"', "grain"]
    assert plan.parts[0].settings == {"text": "go live"}
    comma = piece_plan.plan_piece("a title saying Hello, world plus grain")
    assert comma.parts[0].route == "native"
    assert comma.parts[0].settings == {"text": "Hello, world"}


def test_subject_beats_motion_modifier() -> None:
    plan = piece_plan.plan_piece("a sliding title over a dark background")
    assert [(p.route, p.tool) for p in plan.parts] == [
        ("native", "Text+"),
        ("native", "Background"),
    ]
    alone = piece_plan.plan_piece("fade in over a gradient")
    assert alone.parts[0].tool == "Transform"


def test_native_gated_on_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    from chair_resolve import manifest as resolve_manifest

    monkeypatch.setattr(
        resolve_manifest.MANIFEST.capabilities, "fusion_comps", False
    )
    plan = piece_plan.plan_piece("a sliding title over a dark background")
    assert all(p.route != "native" for p in plan.parts)
    assert "cannot host this natively" in plan.parts[0].note


def test_brief_literals_order_and_hex_tail() -> None:
    assert piece_plan.brief_literals("dither title saying HELLO in #FF0000") == [
        "HELLO"
    ]
    assert piece_plan.brief_literals('kicker "HI" and title "BYE"') == ["HI", "BYE"]
    assert piece_plan.brief_literals("go live") == []
    assert piece_plan.brief_literals("saying Log in over grain") == ["Log in"]


def test_guidance_names_native_steps() -> None:
    plan = piece_plan.plan_piece("a title saying LAUNCH plus grain")
    assert piece_plan.guidance(plan) == (
        "Add Text+ 'LAUNCH' in Resolve; Add FilmGrain in Resolve for 'grain'"
    )
    assert piece_plan.guidance(piece_plan.plan_piece("fade a label in")) == ""
    adapted = piece_plan.guidance(piece_plan.plan_piece(PROOF), adapted_id="mesh-gradient")
    assert "Also reuse" not in adapted
    assert "Add Text+ 'LAUNCH' in Resolve" in adapted


def test_gradient_counts_as_background_scope() -> None:
    assert modules.scope_from_brief("a liquid gradient") == {
        "wantsBackground": True, "wantsText": False,
    }
    assert modules.scope_from_brief("lower third for the host")["wantsText"] is True


def test_empty_brief_fails() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        piece_plan.plan_piece("  ")
    with pytest.raises(InvalidModule, match="non-empty"):
        modules.generate_module("  ")


def test_generate_adapts_reuse_through_the_model(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append((source, scope))
        return ok_report()

    values = {"speed": 0.2, "colorA": "#0a1a3f"}
    client = FakeClient([json.dumps(values)])
    monkeypatch.setattr(modules, "_check_source", fake_check)
    record = modules.generate_module(PROOF, client=client)
    assert record is not None
    assert client.calls == 1
    assert "mesh-gradient" in seen[0][0]
    assert seen[0][1] == {"wantsBackground": True, "wantsText": False}
    assert "default: 0.2" in seen[0][0]
    assert record.brief == "a liquid gradient"
    assert "Adapted from mesh-gradient with muse-spark-1.3-contributor" in record.notes
    assert "Add Text+ 'LAUNCH' in Resolve" in record.notes
    snap = piece_plan.status_snapshot()
    assert snap["adapted"] == 1 and snap["planned"] == 1


def test_generate_adapts_without_a_model(isolated, monkeypatch) -> None:
    monkeypatch.setattr(modules, "_check_source", lambda *a: ok_report())
    _no_model(monkeypatch)
    record = modules.generate_module(PROOF)
    assert record is not None
    assert "(deterministic fallback: no model)" in record.notes


def test_generate_all_native_returns_guidance(isolated) -> None:
    record = modules.generate_module("grain and glow")
    assert record is None
    assert piece_plan.status_snapshot()["guided"] == 1


def test_generate_scopes_new_parts_only(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append(scope)
        return ok_report()

    client = FakeClient([fenced(TEXT_SRC)])
    monkeypatch.setattr(modules, "_check_source", fake_check)
    record = modules.generate_module(
        "a blob that breathes over a dark background", client=client
    )
    assert record is not None
    assert record.brief == "a blob that breathes"
    assert client.last_messages[1].content == "a blob that breathes"
    assert "Piece plan: 1 native, 0 reuse, 1 new." in record.notes
    assert "Add Background in Resolve for 'a dark background'" in record.notes
    assert seen == [{"wantsBackground": False, "wantsText": False}]


def test_generate_single_part_keeps_full_brief(isolated, monkeypatch) -> None:
    client = FakeClient([fenced(TEXT_SRC)])
    monkeypatch.setattr(modules, "_check_source", lambda *a: ok_report())
    record = modules.generate_module("dark title background with big words", client=client)
    assert record is not None
    assert record.brief == "dark title background with big words"
    assert "Piece plan" not in record.notes


def test_generate_with_passed_plan_counts_once(isolated, monkeypatch) -> None:
    client = FakeClient([fenced(TEXT_SRC)])
    monkeypatch.setattr(modules, "_check_source", lambda *a: ok_report())
    plan = piece_plan.plan_piece("fade a label in")
    record = modules.generate_module("fade a label in", client=client, plan=plan)
    assert record is not None
    assert piece_plan.status_snapshot()["planned"] == 1


def _no_model(monkeypatch) -> None:
    def boom(model=None):
        raise InvalidModule("module generation needs a model: test")

    monkeypatch.setattr(modules, "_model_client", boom)


def test_adapt_falls_back_without_a_model(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append(source)
        return ok_report()

    monkeypatch.setattr(modules, "_check_source", fake_check)
    _no_model(monkeypatch)
    record = modules.adapt_library_piece(
        "dither-reveal", "dither title saying HELLO in #FF0000"
    )
    assert 'default: "HELLO"' in seen[0]
    assert 'default: "#ff0000"' in seen[0]
    assert "(deterministic fallback: no model)" in record.notes
    assert "(colorBack, label from the brief)" in record.notes
    with pytest.raises(InvalidModule, match="unknown library piece"):
        modules.adapt_library_piece("nope", "a brief")
    with pytest.raises(InvalidModule, match="unknown library piece"):
        modules.adapt_library_piece("../x", "a brief")


def test_adapt_uses_model_values(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append(source)
        return ok_report()

    values = {"speed": 0.2, "colorBack": "#0A1A3F", "colorFront": "#7FB2FF"}
    client = FakeClient([json.dumps(values)])
    monkeypatch.setattr(modules, "_check_source", fake_check)
    record = modules.adapt_library_piece(
        "dither-reveal", "a slow dither title in deep blue", client=client
    )
    assert client.calls == 1
    assert "speed" in client.last_messages[0].content
    assert "colorBack" in client.last_messages[0].content
    assert "default: 0.2" in seen[0]
    assert 'default: "#0a1a3f"' in seen[0]
    assert 'default: "#7fb2ff"' in seen[0]
    assert "with muse-spark-1.3-contributor" in record.notes
    assert "(colorBack, colorFront, speed from the brief)" in record.notes


def test_adapt_falls_back_on_bad_model_values(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append(source)
        return ok_report()

    monkeypatch.setattr(modules, "_check_source", fake_check)
    record = modules.adapt_library_piece(
        "dither-reveal", "a slow dither title",
        client=FakeClient(['{"nope": 1}']),
    )
    assert "(deterministic fallback: invalid model values)" in record.notes
    assert 'label: { type: "string", default: "Liquid Light"' in seen[0]

    class BoomClient:
        models = type("M", (), {"executor": "boom"})()

        def execute(self, messages):
            raise RuntimeError("network down")

    record = modules.adapt_library_piece(
        "dither-reveal", "a slow dither title", client=BoomClient()
    )
    assert "(deterministic fallback: model call failed)" in record.notes


def test_adapt_falls_back_when_check_rejects_model_values(
    isolated, monkeypatch
) -> None:
    calls: list = []

    def flaky_check(module_id, source, env, scope=None):
        calls.append(source)
        if len(calls) == 1:
            return ok_report(ok=False, errors=["model values broke the frame"])
        return ok_report()

    monkeypatch.setattr(modules, "_check_source", flaky_check)
    record = modules.adapt_library_piece(
        "dither-reveal", "a slow dither title",
        client=FakeClient(['{"speed": 0.2}']),
    )
    assert "(deterministic fallback: model values failed the check)" in record.notes
    assert piece_plan.status_snapshot()["adapted"] == 1


def test_prop_schema_and_value_validation() -> None:
    source = (
        'speed: { type: "number", min: 0, max: 2, default: 1, title: "Speed" },\n'
        'ink: { type: "color", default: "#101018", title: "Ink" },\n'
        'label: { type: "string", default: "Hi", title: "Label" },\n'
        'on: { type: "boolean", default: false, title: "On" },\n'
    )
    schema = modules._prop_schema(source)
    assert [(p["id"], p["type"]) for p in schema] == [
        ("speed", "number"), ("ink", "color"), ("label", "string"), ("on", "boolean"),
    ]
    assert (schema[0]["min"], schema[0]["max"]) == (0.0, 2.0)
    good = modules._validate_values(
        schema, {"speed": 0.2, "ink": "#0A1A3F", "label": "Yo", "on": True}
    )
    assert good == {"speed": 0.2, "ink": "#0a1a3f", "label": "Yo", "on": True}
    for bad in (
        {"nope": 1},
        {"speed": 9},
        {"speed": "fast"},
        {"speed": True},
        {"ink": "blue"},
        {"ink": "#12345"},
        {"label": 5},
        {"on": "yes"},
        ["speed"],
    ):
        with pytest.raises(InvalidModule):
            modules._validate_values(schema, bad)


def test_plan_counts_reach_health(isolated) -> None:
    piece_plan.plan_piece(PROOF)
    piece_plan.plan_piece("fade a label in")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def post(path: str, body: dict) -> dict:
        request = Request(
            base + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request) as response:
            return json.load(response)

    try:
        planned = post("/effects/modules/plan", {"brief": PROOF})
        assert [p["route"] for p in planned["parts"]] == ["native", "reuse", "native"]
        assert planned["parts"][1]["pieceId"] == "mesh-gradient"
        assert planned["counts"] == {"native": 2, "reuse": 1, "new": 0}
        with urlopen(f"{base}/health") as response:
            health = json.load(response)
        assert health["piece_plans"] == {
            "planned": 3, "native": 4, "reuse": 2, "new": 1,
            "adapted": 0, "guided": 0, "last_error": None,
        }
        with pytest.raises(HTTPError) as empty:
            post("/effects/modules/plan", {"brief": "  "})
        assert empty.value.code == 400
    finally:
        server.shutdown()


def test_http_generate_guidance_for_all_native(isolated) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    request = Request(
        f"http://127.0.0.1:{port}/effects/modules/generate",
        data=json.dumps({"brief": "grain and glow"}).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request) as response:
            made = json.load(response)
        assert response.status == 200
        assert made["id"] is None and made["preview"] is None
        assert made["plan"]["counts"] == {"native": 2, "reuse": 0, "new": 0}
        assert "Add FilmGrain in Resolve" in made["notes"]
    finally:
        server.shutdown()


@needs_toolchain
def test_http_generate_adapts_reuse(isolated, monkeypatch) -> None:
    _no_model(monkeypatch)  # deterministic in any env, even with a key
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    request = Request(
        f"http://127.0.0.1:{port}/effects/modules/generate",
        data=json.dumps({"brief": "Dither title piece"}).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request) as response:
            made = json.load(response)
        assert response.status == 200
        assert made["id"].startswith("fxm-")
        assert made["meta"]["id"] == "dither-reveal"
        assert made["checks"]["deterministic"] is True
        assert made["plan"]["parts"][0]["pieceId"] == "dither-reveal"
        assert "Adapted from dither-reveal" in made["notes"]
    finally:
        server.shutdown()


def test_crew_motion_marks_all_native(isolated) -> None:
    from chair_agent.crew.command import Task
    from chair_agent.crew.subagents import run_motion

    out = run_motion(Task(id="t1", beatId="b1", section="motion", goal="grain and glow"))
    assert out.fallback is True
    assert "all-native piece plan" in out.notes


def test_register_source_applies_brief_scope(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_check(module_id, source, env, scope=None):
        seen.append(scope)
        return ok_report()

    monkeypatch.setattr(modules, "_check_source", fake_check)
    modules.register_source("export default function E() {}", brief="a bg wash")
    modules.register_source("export default function E() {}", brief="")
    assert seen == [{"wantsBackground": True, "wantsText": False}, None]


def test_bundle_threads_scope(isolated, monkeypatch) -> None:
    seen: list = []

    def fake_cli(command, entry, out_dir=None, data=None):
        if data is not None:
            seen.append(json.loads(data))
        return {
            "report": ok_report(),
            "id": "chair-tiny-text",
            "files": ["x.ograf.json", "x.js"],
        }

    monkeypatch.setattr(modules, "run_cli", fake_cli)
    record = modules.ModuleRecord(
        id="fxm-000000000002", brief="dark title background",
        source_path=str(isolated / "Effect.tsx"),
    )
    (isolated / "Effect.tsx").write_text("export default function E() {}")
    modules._register(record)
    built = modules.bundle_module(record.id, keyframes={"size": [[0.0, 10]]})
    assert built.stem == "chair-tiny-text"
    assert seen == [{
        "scope": {"wantsBackground": True, "wantsText": True},
        "keyframes": {"size": [[0.0, 10]]},
    }]


@needs_toolchain
def test_import_rejects_unasked_text(isolated) -> None:
    with pytest.raises(InvalidModule, match="no text"):
        modules.register_source(TEXT_SRC, brief="smoothly merging liquid boxes")


@needs_toolchain
def test_bundle_rejects_unasked_background(isolated) -> None:
    opaque = TEXT_SRC.replace(
        'fontSize: size }}>Hello</div>',
        'fontSize: size, background: "#101018" }}>Hello</div>',
    )
    record = modules.register_source(opaque, brief="")
    modules._register(record.model_copy(update={"brief": "merging boxes"}))
    with pytest.raises(InvalidModule, match="no background"):
        modules.bundle_module(record.id)
