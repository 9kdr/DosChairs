import hashlib
import os
from pathlib import Path

from chair_resolve.luatable import LuaTableError, Table, parse
from chair_resolve.manifest import MANIFEST
from chair_resolve.templates import FusionRoot, fusion_roots, scan_fusion

FIXTURES = Path(__file__).parent / "fixtures" / "fusion"
ROOTS = [FusionRoot(FIXTURES / "user", "user"), FusionRoot(FIXTURES / "system", "system")]


def _by_name(result):
    return {piece.name: piece for piece in result.pieces}


def _snapshot(root: Path) -> dict[str, tuple[str, int]]:
    return {
        str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_parse_reads_tables_comments_and_escapes() -> None:
    root = parse(
        '{ -- note\n Tools = ordered() { A = Op { Name = "a \\"b\\"", N = -1.5e1, [3] = true,'
        " 7, Long = [[x]] } } }"
    )
    op = root.get("Tools").get("A")
    assert isinstance(op, Table) and op.type == "Op"
    assert op.get("Name") == 'a "b"'
    assert op.get("N") == -15.0
    assert op.get(3) is True and op.items == [7] and op.get("Long") == "x"


def test_parse_keeps_what_it_read_from_a_cut_off_file() -> None:
    root = parse('{ Tools = { A = Op { Value = 2, Other = ')
    assert root.get("Tools").get("A").get("Value") == 2


def test_parse_refuses_runaway_nesting() -> None:
    try:
        parse("{" * 500)
    except LuaTableError:
        return
    raise AssertionError("deep nesting should raise LuaTableError")


def test_scan_finds_every_kind_in_user_and_system_folders() -> None:
    result = scan_fusion(ROOTS)
    found = {(piece.name, piece.kind, piece.source) for piece in result.pieces}
    assert found >= {
        ("My Lower Third", "title", "user"),
        ("Soft Wipe", "transition", "user"),
        ("Glow Pulse", "macro", "user"),
        ("Cut Off", "title", "user"),
        ("Demo OGraf Lower", "ograf", "user"),
        ("Camera Shake", "effect", "system"),
        ("Color Bars", "generator", "system"),
    }
    assert len(result.roots) == 2
    assert len({piece.id for piece in result.pieces}) == len(result.pieces)


def test_scan_reads_published_inputs() -> None:
    controls = {c.name: c for c in _by_name(scan_fusion(ROOTS))["My Lower Third"].controls}
    assert list(controls) == ["Name", "Bar Color", "Size", "Flip", "Align"]  # label, image skipped
    assert controls["Name"].type == "text" and controls["Name"].default == 'MEL "HOST"'
    assert controls["Bar Color"].type == "color" and controls["Bar Color"].default == "#ff8000"
    size = controls["Size"]
    assert (size.type, size.default, size.min, size.max) == ("number", 1.0, 0.25, 4.0)
    assert controls["Flip"].type == "boolean"
    align = controls["Align"]
    assert align.type == "choice" and align.choices == ("Left", "Center", "Right")
    assert align.default == 1.0  # the inner tool's current value stands in


def test_scan_reads_allowed_range_and_pack_members() -> None:
    pieces = _by_name(scan_fusion(ROOTS))
    softness = pieces["Soft Wipe"].controls[0]
    assert (softness.name, softness.default, softness.min, softness.max) == (
        "Softness", 0.2, 0.0, 1.0,
    )
    shake = pieces["Camera Shake"]
    assert shake.pack == "Pack.drfx"
    assert shake.path.endswith("Pack.drfx!Edit/Effects/Camera Shake.setting")
    assert (shake.controls[0].min, shake.controls[0].max) == (0.0, 1.0)
    assert pieces["Color Bars"].controls[0].default == 7.0


def test_scan_reads_ograf_schema_properties() -> None:
    controls = {c.name: c for c in _by_name(scan_fusion(ROOTS))["Demo OGraf Lower"].controls}
    assert controls["Headline"].type == "text"
    assert controls["Accent"].type == "color" and controls["Accent"].default == "#2563eb"
    assert (controls["Scale"].min, controls["Scale"].max) == (0.5, 2.0)
    assert controls["mode"].choices == ("fast", "slow")
    assert controls["pulse"].type == "boolean" and controls["pulse"].default is True


def test_scan_survives_a_cut_off_template() -> None:
    cut = _by_name(scan_fusion(ROOTS))["Cut Off"]
    assert cut.controls[0].default == 2.0


def test_scan_notes_unreadable_files_and_keeps_going(tmp_path: Path) -> None:
    titles = tmp_path / "Templates" / "Edit" / "Titles"
    titles.mkdir(parents=True)
    (titles / "bad.ograf.json").write_text("{not json")
    (tmp_path / "Templates" / "broken.drfx").write_bytes(b"not a zip")
    (titles / "ok.setting").write_text("{ Tools = { Ok = MacroOperator { } } }")
    result = scan_fusion([FusionRoot(tmp_path, "user")])
    assert [piece.name for piece in result.pieces] == ["ok"]
    assert len(result.errors) == 2


def test_scan_never_writes() -> None:
    before = _snapshot(FIXTURES)
    scan_fusion(ROOTS)
    assert _snapshot(FIXTURES) == before


def test_scan_skips_missing_folders(tmp_path: Path) -> None:
    result = scan_fusion([FusionRoot(tmp_path / "nope", "user")])
    assert result.pieces == [] and result.roots == [] and result.errors == []


def test_roots_follow_the_override_and_default_to_user_then_system() -> None:
    assert [r.path for r in fusion_roots({"CHAIR_FUSION_DIRS": f"/a{os.pathsep}/b"})] == [
        Path("/a"), Path("/b"),
    ]
    defaults = fusion_roots({}, home=Path("/home/x"))
    assert [r.source for r in defaults][0] == "user" and defaults[-1].source == "system"


def test_manifest_declares_the_scan_and_its_fallback() -> None:
    assert MANIFEST.capabilities.template_scan is True
    assert MANIFEST.fallbacks["templateScan"] != ""
