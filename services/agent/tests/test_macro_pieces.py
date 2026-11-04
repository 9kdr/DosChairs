"""Resolve macros as pieces: merged list, query, health, references (#242)."""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import pytest
from chair_agent import effects
from chair_agent.__main__ import Handler
from chair_agent.pieces import macros

FIXTURES = Path(__file__).resolve().parents[3] / "adapters/resolve/tests/fixtures/fusion"
LOWER = "macro:user:title:templates-edit-titles-my-lower-third"


@pytest.fixture(autouse=True)
def fusion(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_FUSION_DIRS", f"{FIXTURES / 'user'}:{FIXTURES / 'system'}")
    monkeypatch.setattr(macros, "_SCAN", None)
    monkeypatch.setattr(macros, "_LAST_ERROR", None)


@pytest.fixture()
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    thread.join(timeout=2)
    httpd.server_close()


def test_health_counts_nothing_until_scanned_then_by_kind() -> None:
    before = macros.status_snapshot()
    assert before["total"] == 0 and before["last_scan_at"] is None
    macros.get_scan()
    after = macros.status_snapshot()
    assert after["counts"] == {
        "effect": 1, "generator": 1, "macro": 1, "ograf": 1, "title": 2, "transition": 1,
    }
    assert after["total"] == 7 and after["catalog"] == 8
    assert after["last_scan_at"].endswith("Z")


def test_list_merges_catalog_pieces_and_macros_with_controls() -> None:
    body = macros.list_pieces(limit=100)
    origins = {entry["origin"] for entry in body["pieces"]}
    assert origins == {"catalog", "macro"} and body["total"] == 15
    hit = macros.list_pieces("lower third")["pieces"][0]
    assert hit["id"] == LOWER and hit["kind"] == "macro" and hit["source"] == "user"
    assert hit["macro_kind"] == "title"
    names = [control["name"] for control in hit["controls"]]
    assert names == ["Name", "Bar Color", "Size", "Flip", "Align"]
    catalog = macros.list_pieces("warm interview")["pieces"][0]
    assert catalog["origin"] == "catalog"
    assert catalog["kind"] == "effect" and catalog["effect"] == "grade"
    assert catalog["controls"][0]["type"] == "choice"


def test_every_piece_carries_a_shelf_kind() -> None:
    body = macros.list_pieces(limit=100)
    kinds = {entry["kind"] for entry in body["pieces"]}
    assert kinds <= {"macro", "effect", "motion", "sound"}
    by_id = {entry["id"]: entry for entry in body["pieces"]}
    assert by_id["kinetic-title"]["kind"] == "motion"
    assert by_id["hero-key-art"]["kind"] == "effect"
    assert macros.shelf_kind("transition") == "motion"
    assert macros.shelf_kind("generator") == "motion"
    assert macros.shelf_kind("effect") == "effect"
    assert macros.shelf_kind("ograf") == "effect"
    assert macros.shelf_kind("title") == "macro"
    assert macros.shelf_kind("macro") == "macro"
    assert macros.shelf_kind("whatever-new") == "macro"


def test_query_with_no_match_is_empty_and_limit_holds() -> None:
    assert macros.list_pieces("zzzz-nothing")["pieces"] == []
    assert len(macros.list_pieces(limit=3)["pieces"]) == 3


def test_http_pieces_macros_and_health(server: str) -> None:
    with urlopen(f"{server}/pieces/macros?q=glow") as response:
        body = json.load(response)
    assert [entry["name"] for entry in body["pieces"]][0] == "Glow Pulse"
    assert body["counts"]["macro"] == 1
    with urlopen(f"{server}/health") as response:
        health = json.load(response)
    assert health["macros"]["total"] == 7
    assert health["macros"]["last_scan_at"] is not None


def test_references_reach_the_generate_prompt_with_their_controls() -> None:
    messages = effects.build_generate_messages(
        "my lower third but with spring physics",
        width=1920, height=1080, fps=30, duration_sec=3,
        references=[{"id": LOWER, "label": "My Lower Third"}, {"id": "gone", "label": "Old"}],
    )
    developer = next(m.content for m in messages if m.role == "developer")
    assert "@My Lower Third (title, user)" in developer
    assert "Size (number, default 1.0, range 0.25 to 4.0)" in developer
    assert "Align (choice, default 1.0, one of Left, Center, Right)" in developer
    assert "@Old: no longer in the library" in developer


def test_no_references_leaves_the_prompt_unchanged() -> None:
    base = {"width": 1920, "height": 1080, "fps": 30, "duration_sec": 3}
    plain = effects.build_generate_messages("a title", **base)
    empty = effects.build_generate_messages("a title", references=[], **base)
    assert plain == empty
