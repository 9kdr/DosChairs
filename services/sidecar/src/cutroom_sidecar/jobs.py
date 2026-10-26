from enum import StrEnum


class JobKind(StrEnum):
    SAM3_MASK = "sam3_mask"
    SAM3D = "sam3d"
    SAM_AUDIO = "sam_audio"
    PROXY = "proxy"
    FRAME = "frame"
    MEASURE_AUDIO = "measure_audio"
