from chair_sidecar.jobs import JobKind


def test_job_kinds() -> None:
    assert JobKind.SAM3_MASK.value == "sam3_mask"
