"""Skills loader: progressive disclosure for the module pipeline (#259)."""

import json
from pathlib import Path

from chair_agent import skills

ROOT = Path(__file__).resolve().parents[3]
PACKAGED = ROOT / "packages" / "effects" / "library" / "index.json"
MIRRORED = ROOT / "services" / "agent" / "skills" / "library" / "index.json"


def test_descriptions_list_every_skill() -> None:
    text = skills.descriptions()
    for skill in ("effects", "motion", "cut", "sound", "color", "graphics", "command"):
        assert f"{skill}:" in text


def test_skill_text_carries_taste() -> None:
    text = skills.skill_text("effects")
    assert "pure function of (props, history, t)" in text
    assert "Restrained, editorial" in text


def test_retrieval_is_capped_and_relevant() -> None:
    context = skills.context_for("smoothly merging liquid boxes")
    assert "liquid-boxes" in context
    assert len(context) <= skills.MAX_CONTEXT_CHARS
    assert "Gold example" in context


def test_retrieval_handles_empty_brief() -> None:
    assert len(skills.context_for("")) <= skills.MAX_CONTEXT_CHARS


def test_library_index_mirrors_the_bundle() -> None:
    assert json.loads(PACKAGED.read_text(encoding="utf-8")) == json.loads(
        MIRRORED.read_text(encoding="utf-8")
    )
