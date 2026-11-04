"""Piece plans: split a brief, route native/reuse/new, generation obeys (#278)."""

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


def test_proof_brief_plans_native_reuse_native() -> None:
    plan = piece_plan.plan_piece(PROOF)
    assert [(p.route, p.tool, p.piece_id) for p in plan.parts] == [
        ("native", "Text+", None),
        ("reuse", None, "liquid-boxes"),
        ("native", "FilmGrain", None),
    ]
    assert plan.parts[0].settings == {"text": "LAUNCH"}
    assert [p.order for p in plan.parts] == [0, 1, 2]
    assert (plan.counts.native, plan.counts.reuse, plan.counts.new) == (2, 1, 0)


@pytest.mark.parametrize(
    "brief",
    [
        "fade a label in",
        "fade",
        "smoothly merging liquid boxes",
        "dark title background with big words",
        "a bouncing logo",
        "Kinetic type: each letter of a short word hangs from a rope",
    ],
)
def test_single_element_briefs_stay_one_new_part(brief: str) -> None:
    plan = piece_plan.plan_piece(brief)
    assert len(plan.parts) == 1
    assert plan.parts[0].route == "new"
    assert plan.parts[0].brief == brief


def test_eval_briefs_never_split() -> None:
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


def test_reuse_names_library_pieces() -> None:
    plan = piece_plan.plan_piece("a morphing icon with glow")
    assert [(p.route, p.piece_id, p.tool) for p in plan.parts] == [
        ("reuse", "morph-icon", None),
        ("native", None, "SoftGlow"),
    ]
    assert "adapt it with props" in plan.parts[0].note


def test_native_gated_on_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    from chair_resolve import manifest as resolve_manifest

    monkeypatch.setattr(
        resolve_manifest.MANIFEST.capabilities, "fusion_comps", False
    )
    plan = piece_plan.plan_piece("a sliding title over a dark background")
    assert all(p.route != "native" for p in plan.parts)
    assert "cannot host this natively" in plan.parts[0].note


def test_empty_brief_fails() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        piece_plan.plan_piece("  ")
    with pytest.raises(InvalidModule, match="non-empty"):
        modules.generate_module("  ")


def test_refusal_names_each_home() -> None:
    message = piece_plan.refusal_message(piece_plan.plan_piece(PROOF))
    assert "already has a home" in message
    assert "Text+" in message and "liquid-boxes" in message and "FilmGrain" in message


def test_generate_refuses_when_every_part_has_a_home(isolated) -> None:
    client = FakeClient([fenced(TEXT_SRC)])
    with pytest.raises(InvalidModule, match="already has a home"):
        modules.generate_module(PROOF, client=client)
    assert client.calls == 0  # the model is never asked for a redundant piece
    snap = piece_plan.status_snapshot()
    assert snap["refused"] == 1 and snap["planned"] == 1
    assert (snap["native"], snap["reuse"], snap["new"]) == (2, 1, 0)


def test_generate_scopes_new_parts_only(isolated, monkeypatch) -> None:
    seen: list = []
    report = {
        "ok": True, "errors": [], "warnings": [],
        "meta": {"id": "blob", "name": "Blob"},
        "props": [{"id": "size"}], "checks": {"deterministic": True},
    }

    def fake_check(module_id, source, env, scope=None):
        seen.append(scope)
        return dict(report)

    client = FakeClient([fenced(TEXT_SRC)])
    monkeypatch.setattr(modules, "_check_source", fake_check)
    record = modules.generate_module(
        "a blob that breathes over a dark background", client=client
    )
    assert record.brief == "a blob that breathes"
    assert client.last_messages[1].content == "a blob that breathes"
    assert "Piece plan: 1 native, 0 reuse, 1 new." in record.notes
    assert seen == [{"wantsBackground": False, "wantsText": False}]


def test_generate_single_part_keeps_full_brief(isolated, monkeypatch) -> None:
    report = {
        "ok": True, "errors": [], "warnings": [],
        "meta": {"id": "tiny-text", "name": "Tiny Text"},
        "props": [{"id": "size"}], "checks": {"deterministic": True},
    }
    client = FakeClient([fenced(TEXT_SRC)])
    monkeypatch.setattr(modules, "_check_source", lambda *a: dict(report))
    record = modules.generate_module("dark title background with big words", client=client)
    assert record.brief == "dark title background with big words"
    assert "Piece plan" not in record.notes


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
        assert planned["parts"][0]["tool"] == "Text+"
        assert planned["counts"] == {"native": 2, "reuse": 1, "new": 0}
        with urlopen(f"{base}/health") as response:
            health = json.load(response)
        assert health["piece_plans"] == {
            "planned": 3, "native": 4, "reuse": 2, "new": 1,
            "refused": 0, "last_error": None,
        }
        with pytest.raises(HTTPError) as empty:
            post("/effects/modules/plan", {"brief": "  "})
        assert empty.value.code == 400
    finally:
        server.shutdown()


def test_register_source_applies_brief_scope(isolated, monkeypatch) -> None:
    seen: list = []
    report = {
        "ok": True, "errors": [], "warnings": [],
        "meta": {"id": "tiny-text", "name": "Tiny Text"},
        "props": [{"id": "size"}], "checks": {"deterministic": True},
    }

    def fake_check(module_id, source, env, scope=None):
        seen.append(scope)
        return dict(report)

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
            "report": {
                "ok": True, "errors": [], "warnings": [],
                "meta": {"id": "tiny-text", "name": "Tiny Text"},
                "props": [{"id": "size"}], "checks": {"deterministic": True},
            },
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
