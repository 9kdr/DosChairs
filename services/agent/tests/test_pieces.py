import pytest
from chair_agent import pieces
from chair_agent.pieces import (
    DIRECTOR_DEFAULTS,
    EFFECTS,
    PIECES,
    WORKFLOWS,
    PieceRecord,
    apply_director_defaults,
    apply_piece_defaults,
    search_pieces,
)


def test_catalog_covers_every_effect_twice() -> None:
    by_effect: dict[str, int] = {}
    for piece in PIECES:
        by_effect[piece.effect] = by_effect.get(piece.effect, 0) + 1
        assert piece.endpoint == piece.effect
        assert piece.inputs and piece.outputs
        assert piece.example.brief and piece.example.plan and piece.example.checks
    assert by_effect == {effect: 2 for effect in EFFECTS}


def test_piece_enums_must_match_their_effect_schema() -> None:
    first = PIECES[0]
    with pytest.raises(ValueError):
        PieceRecord(
            id="bad",
            effect=first.effect,
            title="bad",
            summary="bad",
            endpoint=first.effect,
            inputs=("text:brief",),
            outputs=("image:key-art",),
            enums={},
            example=first.example,
        )


def test_workflows_are_one_endpoint_per_effect() -> None:
    assert set(WORKFLOWS) == set(EFFECTS)
    for effect, workflow in WORKFLOWS.items():
        assert workflow.endpoint == effect
        assert len(workflow.steps) >= 2
        assert workflow.finish_checks


def test_search_ranks_by_effect_first() -> None:
    hits = search_pieces(effect="grade")
    assert [hit.piece.effect for hit in hits[:2]] == ["grade", "grade"]
    assert all(hit.required_refs == hit.piece.required_refs for hit in hits)
    assert hits[0].defaults == {"intensity": "medium", "source": "preset"}


def test_search_uses_query_and_inputs() -> None:
    assert search_pieces(query="lower third")[0].piece.id == "lower-third-name"
    assert search_pieces(inputs=["beat-grid:markers"])[0].piece.id == "kinetic-title"
    with pytest.raises(ValueError):
        search_pieces(effect="warp_drive")  # type: ignore[arg-type]


def test_piece_defaults_fill_omitted_enums_and_reject_bad_values() -> None:
    piece = next(piece for piece in PIECES if piece.id == "warm-interview")
    assert apply_piece_defaults(piece, {}) == {"intensity": "medium", "source": "preset"}
    assert apply_piece_defaults(piece, {"intensity": "strong"})["source"] == "preset"
    with pytest.raises(ValueError):
        apply_piece_defaults(piece, {"lens": "35mm"})
    with pytest.raises(ValueError):
        apply_piece_defaults(piece, {"intensity": "blazing"})


def test_director_defaults_cover_camera_lens_palette_audio() -> None:
    assert set(DIRECTOR_DEFAULTS) == {"camera_move", "lens", "palette", "audio"}
    filled = apply_director_defaults({"camera_move": "whip-pan"})
    assert filled["camera_move"] == "whip-pan"
    assert filled["lens"] == "35mm"
    with pytest.raises(ValueError):
        apply_director_defaults({"dolly": "zoom"})
    with pytest.raises(ValueError):
        apply_director_defaults({"audio": "loud"})


def test_catalog_namespace_exports() -> None:
    assert set(pieces.__all__) >= {"PIECES", "WORKFLOWS", "search_pieces"}
