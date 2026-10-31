from chair_otio.manifest import MANIFEST


def test_otio_is_interchange() -> None:
    assert MANIFEST.adapter == "otio"
    assert MANIFEST.capabilities.markers is True


def test_otio_manifest_says_what_does_not_survive() -> None:
    assert MANIFEST.capabilities.keyframes is False
    assert MANIFEST.capabilities.fusion_comps is False
    assert MANIFEST.fallbacks["keyframes"] == "baked clip"
    assert MANIFEST.fallbacks["fusionComps"] == "prerendered overlay track"
