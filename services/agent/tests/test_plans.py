"""Project plans: front store, back generation, digests, board refs (#261)."""

from pathlib import Path

import pytest
from chair_agent.client import Completion
from chair_agent.plans import (
    PlanError,
    digest_item,
    find_board_item,
    generate_back,
    load_plan,
    plan_payload,
    save_front,
    validate_project_plan,
)

PROJECT = "resolve:dawn-bread"

FRONT = {
    "script_md": "# Dawn bread\n\n## Beat hook\nOpen on the oven door.\n",
    "beats": [
        {"id": "beat_hook", "role": "hook", "text": "Open on the oven door.",
         "startSec": 0, "endSec": 6},
    ],
    "board": [
        {"id": "style-x", "kind": "style", "title": "Warm morning grade",
         "images": ["https://example.com/still.jpg"],
         "notes": "amber highlights", "tags": ["warm"]},
    ],
}

BACK_JSON = (
    '{"tasks": [{"id": "task_1", "title": "Cut the hook on the oven door"}], '
    '"constraints": {"do": ["Keep the face on the A-roll."], '
    '"dont": ["Do not touch source audio."]}}'
)

DIGEST_JSON = (
    '{"palette": ["#d9a05b"], "mood": "warm and quiet", '
    '"motionWords": ["slow push-in"], "keywords": ["morning"]}'
)


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIR_AGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CHAIR_ROOT", str(Path(__file__).resolve().parents[3]))
    return tmp_path


class FakeClient:
    """Mocked Spark: queued planner completion texts, call count for caching."""

    def __init__(self, *texts: str):
        self.texts = list(texts)
        self.calls = 0

    def complete(self, role, messages):
        self.calls += 1
        return Completion(model="muse-spark-1", text=self.texts.pop(0))


def test_empty_plan_validates_against_the_schema(isolated) -> None:
    payload = plan_payload(load_plan(PROJECT))
    assert validate_project_plan(payload).id == PROJECT
    assert payload["front"] == {"script_md": "", "beats": [], "board": []}


def test_save_front_stamps_hash_and_keeps_back(isolated) -> None:
    plan = save_front(PROJECT, FRONT)
    payload = plan_payload(plan)
    validate_project_plan(payload)
    assert payload["frontHash"]
    assert payload["back"] == {
        "tasks": [], "constraints": {"do": [], "dont": []},
        "digests": {}, "frontHash": "", "stale": False,
    }


def test_generate_back_marks_stale_after_front_edit(isolated) -> None:
    save_front(PROJECT, FRONT)
    plan = generate_back(PROJECT, client=FakeClient(BACK_JSON, DIGEST_JSON))
    payload = plan_payload(plan)
    validate_project_plan(payload)
    assert [task["title"] for task in payload["back"]["tasks"]] == [
        "Cut the hook on the oven door"]
    assert payload["back"]["stale"] is False

    edited = dict(FRONT)
    edited["script_md"] = "# Dawn bread\n\nA different opening.\n"
    stale = plan_payload(save_front(PROJECT, edited))
    assert stale["back"]["stale"] is True


def test_digest_is_cached_after_first_vision_call(isolated) -> None:
    save_front(PROJECT, FRONT)
    client = FakeClient(DIGEST_JSON)
    digest_item(PROJECT, "style-x", client=client)
    digest_item(PROJECT, "style-x", client=client)
    assert client.calls == 1
    payload = plan_payload(load_plan(PROJECT))
    assert payload["back"]["digests"]["style-x"]["mood"] == "warm and quiet"


def test_find_board_item_resolves_id_and_title(isolated) -> None:
    save_front(PROJECT, FRONT)
    by_id = find_board_item("board:style-x")
    by_title = find_board_item("@Warm morning grade")
    assert by_id is not None and by_title is not None
    assert by_id["title"] == "Warm morning grade"
    assert by_title["id"] == "style-x"
    with pytest.raises(PlanError):
        digest_item(PROJECT, "missing", client=FakeClient(DIGEST_JSON))


def test_board_items_appear_in_the_piece_listing(isolated) -> None:
    from chair_agent.pieces import macros

    save_front(PROJECT, FRONT)
    assert macros.list_pieces("style-x")["pieces"][0]["id"] == "board:style-x"
    ids = [entry["id"] for entry in macros.list_pieces("warm morning")["pieces"]]
    assert "board:style-x" in ids
    missing = [entry["id"] for entry in macros.list_pieces("zxqv-kwjj")["pieces"]]
    assert "board:style-x" not in missing
    unfiltered = [entry["id"] for entry in macros.list_pieces()["pieces"]]
    assert unfiltered.count("board:style-x") == 1


def test_find_piece_resolves_board_ref_for_effect_briefs(isolated) -> None:
    from chair_agent.pieces import macros

    save_front(PROJECT, FRONT)
    digest_item(PROJECT, "style-x", client=FakeClient(DIGEST_JSON))
    piece = macros.find_piece("board:style-x")
    assert piece is not None and piece["origin"] == "board"
    note = macros.references_note([{"id": "board:style-x", "label": "@style-x"}])
    assert "warm and quiet" in note
    assert "https://example.com/still.jpg" in note
    assert "@Warm morning grade" in note
