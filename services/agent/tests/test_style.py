from pathlib import Path
from typing import Any

import pytest
from chair_agent.style import (
    PRESET_KINDS,
    Exemplar,
    PresetRef,
    StyleProfile,
    load_style_profile,
    parse_style_profile,
    preset,
    presets_for_kind,
)
from pydantic import ValidationError


def _profile_data(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "schemaVersion": "0.1.0",
        "id": "mel-doc",
        "name": "Mel documentary",
        "stats": {
            "avgShotLengthSec": 4.2,
            "jlCutFrequency": 0.3,
            "punchInFrequency": 0.1,
            "targetLoudnessLufs": -16.0,
            "duckAmountDb": 6.0,
            "transitionVocabulary": ["cut", "dissolve"],
        },
        "presets": [
            {"name": "Daylight Warm", "kind": "grade"},
            {"name": "Doc Lower Third", "kind": "title"},
            {"name": "Soft Dissolve", "kind": "transition"},
            {"name": "Clean Subs", "kind": "caption", "sourcePath": "presets/clean-subs.json"},
        ],
        "exemplars": [
            {"id": "cold-open", "summary": "Whip-pan into the title on beat one."},
            {"id": "interview", "summary": "Warm medium grade, lower third on first word."},
            {
                "id": "montage",
                "summary": "Beat-grid cuts, dissolves only on scene changes.",
                "snippetRef": "snippets/montage.json",
            },
        ],
    }
    data.update(overrides)
    return data


def test_parse_ingests_all_four_preset_kinds() -> None:
    profile = parse_style_profile(_profile_data())
    assert profile.id == "mel-doc"
    assert [ref.kind for ref in profile.presets] == ["grade", "title", "transition", "caption"]
    assert profile.stats.avg_shot_length_sec == 4.2
    assert profile.stats.transition_vocabulary == ("cut", "dissolve")
    assert len(profile.exemplars) == 3


def test_load_reads_a_profile_file(tmp_path: Path) -> None:
    import json

    path = tmp_path / "mel.style.json"
    path.write_text(json.dumps(_profile_data()), encoding="utf-8")
    profile = load_style_profile(path)
    assert profile.name == "Mel documentary"


def test_preset_references_by_name() -> None:
    profile = parse_style_profile(_profile_data())
    assert preset(profile, "Daylight Warm") == PresetRef(name="Daylight Warm", kind="grade")
    with pytest.raises(ValueError, match="unknown preset"):
        preset(profile, "Neon Night")


def test_presets_for_kind_filters() -> None:
    profile = parse_style_profile(_profile_data())
    assert presets_for_kind(profile, "grade") == (PresetRef(name="Daylight Warm", kind="grade"),)
    assert presets_for_kind(profile, "motion") == ()
    assert set(PRESET_KINDS) == {"grade", "title", "transition", "caption", "motion"}
    with pytest.raises(ValueError, match="unknown preset kind"):
        presets_for_kind(profile, "lut")  # type: ignore[arg-type]


def test_exemplars_stay_between_three_and_five() -> None:
    two = [
        {"id": "one", "summary": "First."},
        {"id": "two", "summary": "Second."},
    ]
    with pytest.raises(ValidationError):
        parse_style_profile(_profile_data(exemplars=two))
    six = [{"id": f"ex-{n}", "summary": f"Exemplar {n}."} for n in range(6)]
    with pytest.raises(ValidationError):
        parse_style_profile(_profile_data(exemplars=six))
    five = [{"id": f"ex-{n}", "summary": f"Exemplar {n}."} for n in range(5)]
    assert len(parse_style_profile(_profile_data(exemplars=five)).exemplars) == 5


def test_duplicate_preset_names_are_rejected() -> None:
    data = _profile_data()
    data["presets"] = [
        {"name": "Daylight Warm", "kind": "grade"},
        {"name": "Daylight Warm", "kind": "title"},
    ]
    with pytest.raises(ValidationError, match="duplicate preset names"):
        parse_style_profile(data)


def test_unknown_keys_and_kinds_are_rejected() -> None:
    with pytest.raises(ValidationError):
        parse_style_profile(_profile_data(extra=True))
    data = _profile_data()
    data["presets"] = [{"name": "Nope", "kind": "lut"}]
    with pytest.raises(ValidationError):
        parse_style_profile(data)


def test_dump_uses_the_schema_key_names() -> None:
    profile = parse_style_profile(_profile_data())
    dumped = profile.model_dump(by_alias=True, mode="json")
    assert dumped["schemaVersion"] == "0.1.0"
    assert dumped["stats"]["avgShotLengthSec"] == 4.2
    assert dumped["presets"][3]["sourcePath"] == "presets/clean-subs.json"
    assert dumped["exemplars"][2]["snippetRef"] == "snippets/montage.json"
    assert isinstance(Exemplar.model_validate(dumped["exemplars"][0]), Exemplar)
    assert isinstance(StyleProfile.model_validate(dumped), StyleProfile)
