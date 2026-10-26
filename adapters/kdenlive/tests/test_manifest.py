from chair_kdenlive.manifest import MANIFEST


def test_kdenlive_degrades_fusion() -> None:
    assert MANIFEST.capabilities.fusion_comps is False
    assert "fusionComps" in MANIFEST.fallbacks
