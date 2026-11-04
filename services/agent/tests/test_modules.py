"""Effect modules: generate (+ one repair), check, bundle, install, HTTP, health (#241)."""

import json
import os
import shutil
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from chair_agent import modules
from chair_agent.__main__ import Handler
from chair_agent.client import Completion
from chair_agent.modules import InvalidModule

ROOT = Path(__file__).resolve().parents[3]
TOOLCHAIN = (ROOT / "packages" / "effects" / "node_modules" / ".bin" / "esbuild").exists()
needs_toolchain = pytest.mark.skipif(not TOOLCHAIN, reason="run `mise run bootstrap` first")


def _has_chromium() -> bool:
    override = os.environ.get("CHAIR_CHROMIUM", "").strip()
    if override and Path(override).is_file():
        return True
    cache = Path(
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
        or Path.home() / ".cache" / "ms-playwright"
    )
    if cache.is_dir():
        for child in cache.iterdir():
            if child.name.startswith("chromium-") and (child / "chrome-linux" / "chrome").is_file():
                return True
            if child.name.startswith("chromium_headless_shell-") and next(
                (child / "chrome-headless-shell-linux64").glob("chrome-headless-shell"), None
            ):
                return True
    return any(
        shutil.which(name)
        for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")
    )


needs_chromium = pytest.mark.skipif(
    not _has_chromium(), reason="needs a chromium binary for browser verification"
)

GOOD = """\
import React from "react";
import { clamp, easeOutCubic } from "@chair/effects";
export const meta = { id: "fade-label", name: "Fade Label", kind: "overlay",
  durationSec: 3, fps: 30, width: 1280, height: 720 };
export const props = {
  size: { type: "number", min: 20, max: 200, default: 80, title: "Size" },
  tint: { type: "color", default: "#ff6a00", title: "Tint" },
  label: { type: "string", default: "Hello", title: "Text" },
};
export default function Effect({ t, size, tint, label }: any) {
  const a = easeOutCubic(clamp(t / 0.6));
  const style = { position: "absolute", inset: 0, opacity: a };
  return <div style={{ ...style, color: tint, fontSize: size }}>{label}</div>;
}
"""

CLOCK = GOOD.replace("clamp(t / 0.6)", "clamp(Date.now() / 600)")
STATEFUL = GOOD.replace(
    "export default function Effect({ t, size, tint, label }: any) {",
    "let calls = 0;\n"
    "export default function Effect({ t, size, tint, label }: any) {\n  calls += 1;",
).replace("{label}</div>", "{label}{calls}</div>")


def fenced(code: str) -> str:
    return f"Here you go.\n```tsx\n{code}```\n"


class FakeClient:
    def __init__(self, texts):
        self.texts = list(texts)
        self.calls = 0
        self.last_messages = None
        self.models = type("M", (), {"executor": "muse-wonder-1.0"})()

    def execute(self, messages):
        self.calls += 1
        self.last_messages = messages
        return Completion(model="muse-wonder-1.0", text=self.texts.pop(0))


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(ROOT))
    monkeypatch.setenv("CHAIR_OGRAF_DIR", str(tmp_path / "ograf"))
    modules.reset_status()
    return tmp_path


def test_parse_code_takes_fenced_block_or_raw_module() -> None:
    assert modules.parse_code(fenced(GOOD)).strip() == GOOD.strip()
    assert "export default" in modules.parse_code(GOOD)
    with pytest.raises(InvalidModule, match="no `export default`"):
        modules.parse_code("Sorry, I cannot do that.")


def test_prompt_is_built_from_the_approved_imports_file() -> None:
    messages = modules.build_generate_messages(
        "a bouncing logo", kind="overlay", references=[{"name": "swing", "text": "use springs"}],
    )
    developer = messages[0].content
    assert isinstance(developer, str)
    for entry in modules.load_catalogue()["imports"]:
        if not entry.get("hidden"):
            assert entry["name"] in developer
    assert "history(name, tau)" in developer
    assert "meta.kind must be 'overlay'" in developer
    assert "[swing]" in developer
    with pytest.raises(InvalidModule, match="non-empty"):
        modules.build_generate_messages("  ")


@needs_toolchain
def test_generate_checks_and_stores(isolated) -> None:
    client = FakeClient([fenced(GOOD)])
    record = modules.generate_module("fade a label in", client=client)
    assert record.id.startswith("fxm-")
    assert record.meta and record.meta["id"] == "fade-label"
    assert [p["id"] for p in record.props] == ["size", "tint", "label", "transparentBg", "backgroundColor"]
    assert record.checks["deterministic"] is True
    assert record.repaired is False and client.calls == 1
    snap = modules.status_snapshot()
    assert snap["generated"] == 1 and snap["determinism_passes"] == 1
    assert snap["last_error"] is None and isinstance(snap["last_generate_ms"], float)
    modules._MODULES.clear()
    assert modules.get_module(record.id).meta["name"] == "Fade Label"


@needs_toolchain
def test_generate_covers_rig_briefs_with_a_cursor_piece(isolated) -> None:
    """A cursor brief is a normal piece: kind rig, checked, keyframable target (#273)."""
    source = (
        ROOT / "packages" / "effects" / "modules" / "expressive-mouse.tsx"
    ).read_text()
    client = FakeClient([fenced(source)])
    record = modules.generate_module(
        "cursor swings in with momentum, overshoots, settles, then bounces",
        kind="rig", client=client,
    )
    assert record.meta and record.meta["kind"] == "rig"
    assert record.checks["deterministic"] is True
    ids = [prop["id"] for prop in record.props]
    for prop in ("targetX", "targetY", "stiffness", "damping", "mass", "overshoot"):
        assert prop in ids


@needs_toolchain
def test_generate_repairs_once_for_prose_then_for_a_clock(isolated) -> None:
    client = FakeClient(["I think you want a fade.", fenced(GOOD)])
    record = modules.generate_module("fade a label in", client=client)
    assert client.calls == 2 and record.repaired
    assert "repaired on retry" in record.notes
    assert modules.status_snapshot()["repaired"] == 1

    client = FakeClient([fenced(CLOCK), fenced(GOOD)])
    record = modules.generate_module("fade a label in", client=client)
    assert client.calls == 2
    repair_user = client.last_messages[1].content
    assert "Date.now" in repair_user  # the model sees its own broken file
    assert "forbidden API" in client.last_messages[0].content


@needs_toolchain
def test_generate_fails_clearly_after_one_repair(isolated) -> None:
    client = FakeClient([fenced(STATEFUL), fenced(STATEFUL)])
    with pytest.raises(InvalidModule, match="failed the check twice") as caught:
        modules.generate_module("fade", client=client)
    assert "not deterministic" in str(caught.value)
    assert client.calls == 2
    snap = modules.status_snapshot()
    assert snap["generated"] == 0 and snap["generate_failures"] == 1
    assert snap["determinism_failures"] >= 1 and "twice" in snap["last_error"]


@needs_toolchain
def test_unapproved_imports_are_refused(isolated) -> None:
    bad = GOOD.replace(
        'import React from "react";', 'import React from "react";\nimport _ from "lodash";'
    ).replace("{label}</div>", "{_.upperCase(label)}</div>")
    with pytest.raises(InvalidModule, match="not approved"):
        modules.register_source(bad)


@needs_toolchain
def test_bundle_then_install_never_overwrites(isolated) -> None:
    record = modules.register_source(GOOD)
    built = modules.bundle_module(record.id)
    assert built.stem == "chair-fade-label"
    manifest = json.loads(Path(built.files[0]).read_text())
    assert manifest["schema"]["properties"]["tint"]["gddType"] == "color-rrggbb"
    assert manifest["schema"]["properties"]["size"]["maximum"] == 200
    assert manifest["supportsNonRealTime"] is True

    first = modules.install_module(record.id)
    assert first["stem"] == "chair-fade-label" and not first["renamed"]
    original = Path(first["files"][1]).read_text()
    second = modules.install_module(record.id)
    third = modules.install_module(record.id)
    assert (second["stem"], third["stem"]) == ("chair-fade-label-v2", "chair-fade-label-v3")
    renamed = json.loads(Path(second["files"][0]).read_text())
    assert renamed["id"] == "chair-fade-label-v2"
    assert renamed["main"] == "chair-fade-label-v2.js"
    assert renamed["name"].endswith("v2")
    assert Path(first["files"][1]).read_text() == original
    assert modules.status_snapshot()["installed"] == 3


@needs_toolchain
def test_bundle_with_baked_keyframes_embeds_them(isolated) -> None:
    record = modules.register_source(GOOD)
    keyframes = {"size": [[2.0, 200], [0.0, 20]]}
    built = modules.bundle_module(record.id, keyframes=keyframes)
    assert built.keyframes == {"size": [[0.0, 20], [2.0, 200]]}
    js = Path(built.files[1]).read_text()
    assert "keyframes" in js and "[[0,20],[2,200]]" in js.replace(" ", "")
    with pytest.raises(InvalidModule, match="bad keyframes"):
        modules.bundle_module(record.id, keyframes={"size": [["x", 1]]})
    with pytest.raises(InvalidModule, match="bad keyframes"):
        modules.bundle_module(record.id, keyframes=["nope"])


def test_install_needs_a_bundle(isolated) -> None:
    record = modules.ModuleRecord(id="fxm-000000000001", source_path="x")
    modules._register(record)
    with pytest.raises(InvalidModule, match="not bundled yet"):
        modules.install_module(record.id)
    with pytest.raises(InvalidModule, match="unknown module"):
        modules.get_module("fxm-ffffffffffff")
    with pytest.raises(InvalidModule, match="unknown module"):
        modules.get_module("../../etc/passwd")


def test_module_model_is_overridable_by_env() -> None:
    assert modules.module_model({}) == "muse-spark-1.3-contributor"
    assert modules.module_model({"CHAIR_MODULE_MODEL": "muse-wonder-1.0"}) == (
        "muse-wonder-1.0"
    )


def test_wonder_model_is_selected_by_mode(isolated, monkeypatch) -> None:
    seen: dict = {}
    report = {
        "ok": True,
        "errors": [],
        "warnings": [],
        "meta": {"id": "fade-label", "name": "Fade Label"},
        "props": [{"id": "size"}],
        "checks": {"deterministic": True},
    }

    def fake_client(model=None):
        seen["model"] = model
        return FakeClient([fenced(GOOD)])

    monkeypatch.setattr(modules, "_model_client", fake_client)
    monkeypatch.setattr(modules, "_check_source", lambda *args: dict(report))
    record = modules.generate_module(
        "fade", model=modules.WONDER_MODULE_MODEL, mode="wonder"
    )
    assert seen["model"] == modules.WONDER_MODULE_MODEL == "muse-wonder-1.0"
    assert record.model == "muse-wonder-1.0"
    defaulted = modules.generate_module("fade", model=None)
    assert seen["model"] is None
    assert defaulted.model == "muse-wonder-1.0"  # the FakeClient's executor, not the default


def test_modes_produce_different_instructions() -> None:
    spark = "\n\n".join(
        m.content for m in modules.build_generate_messages("smoothly merging liquid boxes")
        if m.role == "developer"
    )
    wonder = "\n\n".join(
        m.content
        for m in modules.build_generate_messages("smoothly merging liquid boxes", mode="wonder")
        if m.role == "developer"
    )
    assert "pick one and adapt it" in spark
    assert "liquid-boxes" in spark
    assert "Toolbox, optional" in wonder
    assert "pick one and adapt it" not in wonder
    golds = (
        "liquid-boxes", "dither-reveal", "lower-third",
        "physics-letters", "morph-icon", "mesh-gradient",
    )
    for gold in golds:
        assert gold in wonder  # the whole library is offered as one-line rows
    with pytest.raises(InvalidModule, match="unknown mode"):
        modules.build_generate_messages("fade", mode="party")


def test_scope_from_brief() -> None:
    assert modules.scope_from_brief("smoothly merging liquid boxes") == {
        "wantsBackground": False, "wantsText": False,
    }
    assert modules.scope_from_brief("dark title background with big words") == {
        "wantsBackground": True, "wantsText": True,
    }
    assert modules.scope_from_brief("a bg wash")["wantsBackground"] is True
    assert modules.scope_from_brief("lower subtitle")["wantsText"] is True


@needs_toolchain
def test_generate_rejects_unasked_opaque_frame(isolated) -> None:
    opaque = GOOD.replace(
        "const style = { position: \"absolute\", inset: 0, opacity: a };",
        "const style = { position: \"absolute\", inset: 0, opacity: a, background: \"#101018\" };",
    )
    client = FakeClient([fenced(opaque), fenced(opaque)])
    with pytest.raises(InvalidModule, match="no background") as caught:
        # "blobs", not "boxes": boxes would reuse liquid-boxes instead of
        # drafting, and this test needs the model drafting path.
        modules.generate_module("smoothly merging liquid blobs", client=client)
    assert "failed the check twice" in str(caught.value)


BROKEN_SHADER = """\
import React from "react";
import { ShaderPass } from "@chair/effects";
export const meta = { id: "bad-shader", name: "Bad Shader", kind: "overlay",
  durationSec: 2, fps: 30, width: 640, height: 360 };
export const props = {
  hue: { type: "number", min: 0, max: 1, default: 0.5, title: "Hue" },
};
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  vec2 bad = (u_hue - 0.5) * 2.0;
  oColor = vec4(bad, 0.0, 1.0);
}`;
export default function Effect({ t, hue, width, height }: any) {
  const uniforms = { u_hue: hue, u_time: t };
  return <ShaderPass frag={FRAG} width={width} height={height} uniforms={uniforms} />;
}
"""


@needs_toolchain
@needs_chromium
def test_generate_rejects_failure_fallback_with_gl_log(isolated) -> None:
    client = FakeClient([fenced(BROKEN_SHADER), fenced(BROKEN_SHADER)])
    with pytest.raises(InvalidModule, match="failed the check twice") as caught:
        # "blobs", not "boxes": boxes would reuse liquid-boxes instead of
        # drafting, and this test needs the model drafting path.
        modules.generate_module("smoothly merging liquid blobs", client=client)
    assert "failure fallback" in str(caught.value)
    assert "dimension mismatch" in str(caught.value)


def test_spark_prompt_bans_full_frame_washes() -> None:
    spark = "\n\n".join(
        m.content for m in modules.build_generate_messages("smoothly merging liquid boxes")
        if m.role == "developer"
    )
    assert "No full-frame washes" in spark


def test_generate_threads_brief_scope_into_the_check(isolated, monkeypatch) -> None:
    seen: list = []
    report = {
        "ok": True, "errors": [], "warnings": [],
        "meta": {"id": "fade-label", "name": "Fade Label"},
        "props": [{"id": "size"}], "checks": {"deterministic": True},
    }

    def fake_check(module_id, source, env, scope=None):
        seen.append(scope)
        return dict(report)

    monkeypatch.setattr(modules, "_check_source", fake_check)
    monkeypatch.setattr(modules, "_model_client", lambda model=None: FakeClient([fenced(GOOD)]))
    modules.generate_module("smoothly merging liquid boxes")
    modules.generate_module("dark title background with big words")
    assert seen == [
        {"wantsBackground": False, "wantsText": False},
        {"wantsBackground": True, "wantsText": True},
    ]


def test_generate_prompt_carries_skills_and_library() -> None:
    messages = modules.build_generate_messages("smoothly merging liquid boxes")
    developer = "\n\n".join(m.content for m in messages if m.role == "developer")
    assert "House skills" in developer
    assert "liquid-boxes" in developer
    assert len(developer) <= 30000  # catalogue + references + capped skills block


def test_status_codes() -> None:
    assert modules.error_status(InvalidModule("unknown module: 'x'")) == 404
    assert modules.error_status(InvalidModule("model call failed: boom")) == 502
    assert modules.error_status(InvalidModule("module toolchain: no node")) == 503
    assert modules.error_status(InvalidModule("module failed the check: x")) == 400


@needs_toolchain
def test_http_generate_bundle_preview_install_and_health(isolated, monkeypatch) -> None:
    client = FakeClient([fenced(GOOD)])
    monkeypatch.setattr(modules, "_model_client", lambda model=None: client)
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
        made = post("/effects/modules/generate", {
            "brief": "fade a label in", "canvas": {"width": 1280, "height": 720},
            "fps": 30, "durationSec": 3,
        })
        assert made["checks"]["deterministic"] is True and len(made["props"]) == 5
        module_id = made["id"]
        bundled = post(f"/effects/modules/{module_id}/bundle", {})
        assert bundled["stem"] == "chair-fade-label"
        with urlopen(f"{base}/effects/modules/{module_id}/preview") as response:
            page = response.read().decode()
        assert f"files/{bundled['stem']}.js" in page and "goToTime" in page
        with urlopen(f"{base}/effects/modules/{module_id}/files/{bundled['stem']}.js") as response:
            assert b"goToTime" in response.read()
        installed = post(f"/effects/modules/{module_id}/install", {})
        assert installed["stem"] == "chair-fade-label"
        with urlopen(f"{base}/health") as response:
            health = json.load(response)
        block = health["modules"]
        assert block["generated"] == 1 and block["bundled"] == 1 and block["installed"] == 1
        assert block["determinism_passes"] >= 1 and block["model"] == "muse-spark-1.3-contributor"
        with pytest.raises(HTTPError) as missing:
            urlopen(f"{base}/effects/modules/fxm-ffffffffffff/preview")
        assert missing.value.code == 404
        with pytest.raises(HTTPError) as traversal:
            urlopen(f"{base}/effects/modules/{module_id}/files/..%2Frecord.json")
        assert traversal.value.code == 404
    finally:
        server.shutdown()
