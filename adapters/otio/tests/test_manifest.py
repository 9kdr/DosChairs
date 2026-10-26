from cutroom_otio.manifest import MANIFEST


def test_otio_is_interchange() -> None:
    assert MANIFEST.adapter == "otio"
    assert MANIFEST.capabilities.markers is True
