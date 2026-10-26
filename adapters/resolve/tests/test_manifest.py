from cutroom_resolve.manifest import MANIFEST


def test_resolve_declares_fusion() -> None:
    assert MANIFEST.adapter == "resolve"
    assert MANIFEST.capabilities.fusion_comps is True
