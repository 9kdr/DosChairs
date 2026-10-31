"""Style profile: the editor's taste as named preset references.

Mirrors schemas/style-profile.schema.json. Ingested grade, title,
transition, and caption presets become PresetRef entries; the agent cites
them by name instead of inventing looks. Exemplars are 3-5 short snippet
summaries, never fine-tuning data. Loading a profile never touches source
media or the timeline.
"""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PresetKind = Literal["grade", "title", "transition", "caption", "motion"]

PRESET_KINDS: tuple[PresetKind, ...] = ("grade", "title", "transition", "caption", "motion")

SCHEMA_VERSION = "0.1.0"


class StyleStats(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    avg_shot_length_sec: float | None = Field(default=None, alias="avgShotLengthSec")
    jl_cut_frequency: float | None = Field(default=None, alias="jlCutFrequency")
    punch_in_frequency: float | None = Field(default=None, alias="punchInFrequency")
    target_loudness_lufs: float | None = Field(default=None, alias="targetLoudnessLufs")
    duck_amount_db: float | None = Field(default=None, alias="duckAmountDb")
    transition_vocabulary: tuple[str, ...] = Field(default=(), alias="transitionVocabulary")


class PresetRef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    name: str = Field(min_length=1)
    kind: PresetKind
    source_path: str | None = Field(default=None, alias="sourcePath")


class Exemplar(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    snippet_ref: str | None = Field(default=None, alias="snippetRef")


class StyleProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: Literal["0.1.0"] = Field(default=SCHEMA_VERSION, alias="schemaVersion")
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    stats: StyleStats = Field(default_factory=StyleStats)
    presets: tuple[PresetRef, ...] = ()
    exemplars: tuple[Exemplar, ...] = Field(min_length=3, max_length=5)

    @model_validator(mode="after")
    def _preset_names_unique(self) -> "StyleProfile":
        names = [ref.name for ref in self.presets]
        dupes = sorted({name for name in names if names.count(name) > 1})
        if dupes:
            raise ValueError(f"duplicate preset names: {dupes}")
        return self


def parse_style_profile(data: Mapping[str, Any]) -> StyleProfile:
    """Validate ingested preset data into a StyleProfile. Rejects bad shapes."""
    return StyleProfile.model_validate(data)


def load_style_profile(path: str | Path) -> StyleProfile:
    """Load a style profile JSON file. Rejects bad shapes."""
    return parse_style_profile(json.loads(Path(path).read_text(encoding="utf-8")))


def preset(profile: StyleProfile, name: str) -> PresetRef:
    """The agent's by-name preset reference. Rejects unknown names."""
    for ref in profile.presets:
        if ref.name == name:
            return ref
    raise ValueError(f"unknown preset: {name!r}")


def presets_for_kind(profile: StyleProfile, kind: PresetKind) -> tuple[PresetRef, ...]:
    """Presets of one kind. Rejects unknown kinds."""
    if kind not in PRESET_KINDS:
        raise ValueError(f"unknown preset kind: {kind!r}")
    return tuple(ref for ref in profile.presets if ref.kind == kind)
