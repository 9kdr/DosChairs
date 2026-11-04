"""Report formatting and pass/fail logic of the demo check script only."""

import importlib.util
import json

RUN_PATH = __file__.rsplit("/", 1)[0] + "/run.py"


def load_run():
    spec = importlib.util.spec_from_file_location("demo_check_run", RUN_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_report(run):
    effect = run.new_flow("effect", "prompt e")
    effect.update({"status": "PASS", "reason": "new comp c1 with 6 tools",
                   "seconds": {"generate": 3.0, "apply": 1.5, "undo": 0.2}})
    rig = run.new_flow("rig", "prompt r")
    rig.update({"status": "FAIL", "reason": "bake left no keys on scale",
                "seconds": {"generate": 4.0, "bake": 0.5}})
    return {"timestamp": "2026-11-04T00:00:00+00:00", "agent": "http://x",
            "mode": "dry-run", "project": "Chair Captest",
            "timeline": "demo-check", "flows": [effect, rig],
            "path": "/tmp/demo-check/t.json"}


def test_table_shows_each_flow_with_plain_reason():
    run = load_run()
    table = run.format_table(make_report(run))
    assert "effect" in table and "PASS" in table
    assert "new comp c1 with 6 tools" in table
    assert "rig" in table and "FAIL" in table
    assert "bake left no keys on scale" in table
    assert "1/2 flows passed" in table


def test_table_shows_step_times():
    run = load_run()
    table = run.format_table(make_report(run))
    assert "g=3.0s" in table and "a=1.5s" in table and "u=0.2s" in table
    assert "b=0.5s" in table


def test_all_pass_needs_every_flow_green():
    run = load_run()
    report = make_report(run)
    assert run.all_pass(report) is False
    report["flows"][1]["status"] = "PASS"
    assert run.all_pass(report) is True
    report["flows"] = []
    assert run.all_pass(report) is False


def test_new_flow_defaults_to_fail_with_tokens_note():
    run = load_run()
    flow = run.new_flow("sound", "prompt s")
    assert flow["status"] == "FAIL"
    assert "not exposed" in flow["tokens_cost"]
    assert flow["seconds"] == {}


def test_check_undo_accepts_switch_and_remove():
    run = load_run()
    assert run.check_undo(["Comp 1", "Comp 2"], "Comp 2", "Comp 1",
                          ["Comp 1"]) == "switch"
    assert run.check_undo(["Comp 1"], "Comp 2", "Comp 1",
                          ["Comp 1"]) == "remove"


def test_check_undo_proves_an_unwind_by_tool_drop():
    run = load_run()
    assert run.check_undo(["Comp 1"], "Comp 1", None, [],
                          tools_now=4, tools_before=14) == "unwind"


def test_check_undo_rejects_a_broken_undo():
    import pytest

    run = load_run()
    with pytest.raises(run.Fail, match="standing with its build"):
        run.check_undo(["Comp 2"], "Comp 2", "Comp 1", ["Comp 1"])
    with pytest.raises(run.Fail, match="expected"):
        run.check_undo(["Comp 1", "Comp 2"], "Comp 9", "Comp 1", ["Comp 1"])
    with pytest.raises(run.Fail, match="standing with its build"):
        run.check_undo(["Comp 1"], "Comp 1", None, [],
                       tools_now=14, tools_before=14)


def test_report_json_shape(tmp_path):
    run = load_run()
    report = make_report(run)
    path = tmp_path / "r.json"
    path.write_text(json.dumps(report))
    loaded = json.loads(path.read_text())
    assert [flow["name"] for flow in loaded["flows"]] == ["effect", "rig"]
    assert all("reason" in flow and "seconds" in flow
               for flow in loaded["flows"])


def test_rig_controls_found_by_name():
    run = load_run()
    ids = ["targetX", "targetY", "stiffness", "mass", "swing", "accent"]
    assert run.target_axis(ids, "x") == "targetX"
    assert run.target_axis(ids, "y") == "targetY"
    assert run.match_control(ids, "stiff") == "stiffness"
    assert run.match_control(ids, "mass") == "mass"
    assert run.match_control(ids, "swing") == "swing"
    assert run.target_axis(["accent"], "x") is None
    assert run.match_control(["accent"], "mass") is None
    full = [{"id": "targetX", "type": "number", "default": 960},
            {"label": "no id here"}, "bare"]
    assert run.prop_ids(full) == ["targetX", "bare"]


def test_strip_png_is_a_valid_png(tmp_path):
    run = load_run()
    poses = [{"t": round(i * 0.1, 1), "x": 120.0 + i * 80.0,
              "y": 540.0, "tilt": 0.0} for i in range(12)]
    path = run.write_strip_png(poses, str(tmp_path / "strip.png"), cells=4)
    raw = open(path, "rb").read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    import struct
    width, height = struct.unpack(">II", raw[16:24])
    assert (width, height) == (4 * 160 + 3 * 6, 90)


def test_flow_rig_passes_on_dry_fakes(tmp_path, monkeypatch):
    run = load_run()
    monkeypatch.setattr(run, "REPORT_DIR", str(tmp_path))
    info = {"width": 1920, "height": 1080, "fps": 24.0,
            "duration_sec": 40.0, "total_frames": 960, "rate": 24.0,
            "proxy_url": "/tmp/dry-dialogue.mp4",
            "music_clip_id": "dry-music-1"}
    flow = run.flow_rig(run.Dry("http://x"), {"rig": "prompt r"},
                        info, {"comps": [], "timelines": []})
    assert flow["status"] == "PASS", flow["reason"]
    assert flow["evidence"]["module_id"] == "fxm-dry-1"
    assert flow["evidence"]["controls"]["stiffness"] == "stiffness"
    assert flow["evidence"]["feel"]["settle_dev_px"] >= 0
    strips = list((tmp_path / "rig").glob("strip-*.png"))
    assert len(strips) == 1
    assert flow["evidence"]["strip"] == str(strips[0])
