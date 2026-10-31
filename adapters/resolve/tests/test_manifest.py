from chair_resolve.manifest import MANIFEST


def test_resolve_declares_fusion() -> None:
    assert MANIFEST.adapter == "resolve"
    assert MANIFEST.capabilities.fusion_comps is True


def test_resolve_falls_back_on_unscriptable_tracks() -> None:
    assert MANIFEST.fallbacks["subtitles"] != ""
    assert MANIFEST.fallbacks["adjustmentLayers"] != ""
