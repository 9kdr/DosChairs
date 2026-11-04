"""Piece catalog: one reusable workflow per effect.

Pieces are hyper-specific skills the planner picks by input/output type.
Creative enums stay omissible: the auto-director fills each piece's enum
defaults (mirroring schemas/plan-*.schema.json) plus DIRECTOR_DEFAULTS for
camera, lens, palette, and audio. Unknown names or values raise; a bad plan
is rejected, never silently fixed.
"""

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EffectName = Literal["muse_image", "sam3_mask", "grade", "motion_graphics"]

EFFECTS: tuple[EffectName, ...] = ("muse_image", "sam3_mask", "grade", "motion_graphics")

PieceKind = Literal["macro", "effect", "motion", "sound"]

_EFFECT_SHELF: dict[EffectName, PieceKind] = {
    "muse_image": "effect",
    "sam3_mask": "effect",
    "grade": "effect",
    "motion_graphics": "motion",
}


def piece_kind(effect: EffectName) -> PieceKind:
    """Shelf kind for a catalog piece; unknown workflows land on macro."""
    return _EFFECT_SHELF.get(effect, "macro")


class EnumSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    values: tuple[str, ...] = Field(min_length=1)
    default: str

    @model_validator(mode="after")
    def _default_in_values(self) -> "EnumSpec":
        if self.default not in self.values:
            raise ValueError(f"default {self.default!r} is not one of {list(self.values)!r}")
        return self


# Creative enums per effect. Values and defaults mirror the plan schemas.
EFFECT_ENUMS: dict[EffectName, dict[str, EnumSpec]] = {
    "muse_image": {
        "aspect": EnumSpec(values=("1:1", "16:9", "9:16"), default="16:9"),
        "style": EnumSpec(values=("photo", "cinematic", "illustration"), default="cinematic"),
    },
    "sam3_mask": {
        "promptKind": EnumSpec(values=("text", "point", "box"), default="text"),
        "trackMode": EnumSpec(values=("single", "tracked"), default="tracked"),
    },
    "grade": {
        "intensity": EnumSpec(values=("subtle", "medium", "strong"), default="medium"),
        "source": EnumSpec(values=("preset", "reference"), default="preset"),
    },
    "motion_graphics": {
        "template": EnumSpec(
            values=("lower-third", "title-card", "callout"), default="lower-third"
        ),
        "loop": EnumSpec(values=("once", "loop"), default="once"),
    },
}

# Auto-director knobs shared across picture pieces. Shaped into the prompt,
# not the plan params, so plans keep validating against their schema.
DIRECTOR_ENUMS: dict[str, EnumSpec] = {
    "camera_move": EnumSpec(
        values=("static", "push-in", "pull-out", "whip-pan", "orbit"), default="push-in"
    ),
    "lens": EnumSpec(values=("24mm", "35mm", "50mm", "85mm"), default="35mm"),
    "palette": EnumSpec(
        values=("ink-paper-accent", "neon-night", "warm-film", "mono"), default="ink-paper-accent"
    ),
    "audio": EnumSpec(values=("on", "off", "ducked"), default="on"),
}

DIRECTOR_DEFAULTS: dict[str, str] = {
    name: spec.default for name, spec in DIRECTOR_ENUMS.items()
}


class PieceExample(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    brief: str = Field(min_length=1)
    plan: dict[str, Any]
    checks: tuple[str, ...] = Field(min_length=1)


class PieceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    effect: EffectName
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    endpoint: str = Field(min_length=1)
    inputs: tuple[str, ...] = Field(min_length=1)
    outputs: tuple[str, ...] = Field(min_length=1)
    required_refs: tuple[str, ...] = ()
    enums: dict[str, EnumSpec]
    example: PieceExample

    @model_validator(mode="after")
    def _enums_match_effect(self) -> "PieceRecord":
        if set(self.enums) != set(EFFECT_ENUMS[self.effect]):
            raise ValueError(f"piece {self.id!r} enums must match the {self.effect} plan schema")
        return self


class EffectWorkflow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    effect: EffectName
    endpoint: str = Field(min_length=1)
    steps: tuple[str, ...] = Field(min_length=1)
    finish_checks: tuple[str, ...] = Field(min_length=1)


class PieceHit(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    piece: PieceRecord
    required_refs: tuple[str, ...]
    defaults: dict[str, str]


def _workflow(effect: EffectName, endpoint: str, make: str, check: str) -> EffectWorkflow:
    return EffectWorkflow(
        effect=effect,
        endpoint=endpoint,
        steps=(
            f"Validate the {effect} plan against its schemas/plan-*.schema.json.",
            f"Run {endpoint} for each shot; {make}.",
            "Bridge shots to pending changeset items; wait for human accept.",
        ),
        finish_checks=(check, "No source media overwritten."),
    )


WORKFLOWS: dict[EffectName, EffectWorkflow] = {
    "muse_image": _workflow(
        "muse_image",
        "muse_image",
        "fill omitted director knobs from DIRECTOR_DEFAULTS first",
        "Every picture inspected at 100%: no brand marks, no invented text.",
    ),
    "sam3_mask": _workflow(
        "sam3_mask",
        "sam3_mask",
        "track the matte across the shot",
        "Matte edges hold on motion; output is a separate matte track.",
    ),
    "grade": _workflow(
        "grade",
        "grade",
        "name the editor preset instead of inventing a look",
        "Grade cites its preset or reference; skin tones stay natural.",
    ),
    "motion_graphics": _workflow(
        "motion_graphics",
        "motion_graphics",
        "place blocks on the music beat grid from precomputed markers",
        "Still frames under 25%; no hold over 0.6 s; cuts land on beats.",
    ),
}


def _piece(
    id: str,
    effect: EffectName,
    title: str,
    summary: str,
    inputs: tuple[str, ...],
    outputs: tuple[str, ...],
    required_refs: tuple[str, ...],
    brief: str,
    prompt: str,
    params: dict[str, str],
    checks: tuple[str, ...],
) -> PieceRecord:
    return PieceRecord(
        id=id,
        effect=effect,
        title=title,
        summary=summary,
        endpoint=effect,
        inputs=inputs,
        outputs=outputs,
        required_refs=required_refs,
        enums=EFFECT_ENUMS[effect],
        example=PieceExample(
            brief=brief, plan={"effect": effect, "prompt": prompt, "params": params}, checks=checks
        ),
    )


PIECES: tuple[PieceRecord, ...] = (
    _piece(
        "hero-key-art",
        "muse_image",
        "Hero key art",
        "Cinematic 16:9 key art for the title card and thumbnail.",
        ("text:brief",),
        ("image:key-art",),
        (),
        "A courier on a scooter in a rainy neon city, logo space top left.",
        "Stylised 3D courier on a yellow scooter, rainy neon city, 35mm, ink-paper-accent",
        {"aspect": "16:9", "style": "cinematic"},
        ("Inspected at 100%: no brand marks, no invented text.",),
    ),
    _piece(
        "cutaway-stills",
        "muse_image",
        "Illustrated cutaways",
        "Square illustration stills that cover jump cuts in talking-head footage.",
        ("text:brief", "image:reference-look"),
        ("image:cutaway",),
        ("reference look",),
        "Flat illustration of a mailbox monster, warm-film palette.",
        "Flat illustration, mailbox monster, warm-film palette, 1:1",
        {"aspect": "1:1", "style": "illustration"},
        ("Palette matches the reference look.",),
    ),
    _piece(
        "subject-matte",
        "sam3_mask",
        "Tracked subject matte",
        "Text-prompted matte that follows the speaker for background swaps.",
        ("clip:video", "text:prompt"),
        ("video:matte-track",),
        ("source clip",),
        "Matte the speaker, tracked, to blur the background.",
        "the speaker in the red jacket",
        {"promptKind": "text", "trackMode": "tracked"},
        ("Matte edges hold on motion; output is a separate matte track.",),
    ),
    _piece(
        "product-pop",
        "sam3_mask",
        "Product pop-out",
        "Box-prompted single-frame matte that isolates a product for a punch-in.",
        ("clip:video", "text:prompt"),
        ("video:matte-track",),
        ("source clip",),
        "Isolate the cereal box for a 6-frame punch-in.",
        "the cereal box, front face",
        {"promptKind": "box", "trackMode": "single"},
        ("Box sits on the product for the full 6 frames.",),
    ),
    _piece(
        "warm-interview",
        "grade",
        "Warm interview grade",
        "Medium-strength preset grade that flatters skin tones in daylight rooms.",
        ("clip:video",),
        ("grade:look",),
        (),
        "Daylight interview, warm and trustworthy.",
        "Warm interview grade from the Daylight Warm preset, medium strength",
        {"intensity": "medium", "source": "preset"},
        ("Grade names the Daylight Warm preset; skin tones stay natural.",),
    ),
    _piece(
        "match-reference",
        "grade",
        "Reference-matched grade",
        "Subtle grade that matches new footage to an approved reference still.",
        ("clip:video", "image:reference-still"),
        ("grade:look",),
        ("reference still",),
        "Match the vlog footage to the approved neon-night thumbnail.",
        "Match to reference still, neon-night palette, subtle",
        {"intensity": "subtle", "source": "reference"},
        ("Side-by-side with the reference still passes.",),
    ),
    _piece(
        "kinetic-title",
        "motion_graphics",
        "Kinetic title card",
        "Beat-grid kinetic type with a whip-pan drop, built from scene blocks.",
        ("text:phrases", "audio:music-bed", "beat-grid:markers"),
        ("video:overlay-clip",),
        ("music bed with beat grid",),
        "24 s teaser: huge words on every beat, whip-pan into the title.",
        "YOU ARE THE POST., title-card, whip-pan, one word per beat",
        {"template": "title-card", "loop": "once"},
        ("Still frames under 25%; no hold over 0.6 s; cuts land on beats.",),
    ),
    _piece(
        "lower-third-name",
        "motion_graphics",
        "Speaker lower third",
        "Lower-third name strap with a push-in, timed to the first spoken word.",
        ("text:name", "clip:video"),
        ("video:overlay-clip",),
        ("speaker name",),
        "Name strap for the host, in for 3 s on first mention.",
        "MEL — HOST, lower-third, push-in, 35mm",
        {"template": "lower-third", "loop": "once"},
        ("Type never clips the safe area; out on the next cut.",),
    ),
)

def _fill(specs: Mapping[str, EnumSpec], params: Mapping[str, str], what: str) -> dict[str, str]:
    unknown = set(params) - set(specs)
    if unknown:
        raise ValueError(f"unknown {what}: {sorted(unknown)}")
    filled = {}
    for name, spec in specs.items():
        value = params.get(name, spec.default)
        if value not in spec.values:
            raise ValueError(f"invalid value for {name}: {value!r}")
        filled[name] = value
    return filled


def apply_piece_defaults(piece: PieceRecord, params: Mapping[str, str]) -> dict[str, str]:
    """Fill omissible creative enums from the piece defaults. Rejects unknowns."""
    return _fill(piece.enums, params, "piece params")


def apply_director_defaults(params: Mapping[str, str]) -> dict[str, str]:
    """Fill omitted camera/lens/palette/audio knobs. Rejects unknowns."""
    return _fill(DIRECTOR_ENUMS, params, "director knobs")


def search_pieces(
    *,
    effect: EffectName | None = None,
    query: str = "",
    inputs: Sequence[str] = (),
) -> list[PieceHit]:
    """Rank pieces by effect type, then query overlap, then input overlap."""
    if effect is not None and effect not in EFFECTS:
        raise ValueError(f"unknown effect: {effect!r}")
    tokens = [token for token in query.lower().split() if token]
    ranked: list[tuple[int, PieceRecord]] = []
    for piece in PIECES:
        score = 0
        if effect is not None and piece.effect == effect:
            score += 10
        haystack = " ".join(
            (piece.id, piece.title, piece.summary, *piece.inputs, *piece.outputs)
        ).lower()
        score += sum(1 for token in tokens if token in haystack)
        score += 2 * sum(1 for want in inputs if want in piece.inputs)
        ranked.append((score, piece))
    ranked.sort(key=lambda item: (-item[0], item[1].id))
    return [
        PieceHit(
            piece=piece,
            required_refs=piece.required_refs,
            defaults={name: spec.default for name, spec in piece.enums.items()},
        )
        for _, piece in ranked
    ]
