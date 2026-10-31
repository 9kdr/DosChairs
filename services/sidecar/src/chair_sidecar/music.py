"""Offline music analysis: beat grids, transients, and word markers.

Decodes to mono PCM with ffmpeg, then runs stdlib-only DSP: log-flux onset
picking against an adaptive median threshold (aubio/essentia convention),
tempo from clustered inter-onset intervals folded into range, and a beat
grid snapped to nearby onsets. No weights, no new dependencies.

Quantization follow-up (not built here): cuts and effects quantize to these
markers with 2-6 frame anticipation, and word timings drive karaoke-style
caption highlighting. That needs the marker import path in the Resolve
adapter plus per-effect anticipation offsets; this module only delivers the
timestamps and the import-ready payloads.
"""

import math
from collections.abc import Sequence
from statistics import median

SAMPLE_RATE = 22050
HOP = 512
WINDOW = 1024
FRAME_RATE = SAMPLE_RATE / HOP
MIN_BPM = 40.0
MAX_BPM = 220.0
MIN_PEAK_GAP = 4  # frames (~93ms); merges dense rolls, fine for markers
FLUX_FLOOR = 0.02  # sine ripple measures ~0.005, real onsets ~0.1 and up
IOI_TOLERANCE = 0.03  # cluster intervals within 3% (speech will not hold this)
MIN_CLUSTER_IOIS = 3
MIN_CLUSTER_FRACTION = 0.3
SNAP_WINDOW = 0.06  # beats snap to the nearest onset inside this (seconds)


def onset_envelope(samples: Sequence[int]) -> list[float]:
    """Log energy of the first difference per hop frame (high-frequency flux)."""
    # ponytail: O(n) python loop; numpy when a real track says it is slow.
    total = len(samples)
    envelope: list[float] = []
    for frame in range(total // HOP):
        low = max(frame * HOP, 1)
        high = min(frame * HOP + WINDOW, total)
        span = high - low
        if span <= 0:
            envelope.append(0.0)
            continue
        energy = 0
        for i in range(low, high):
            diff = samples[i] - samples[i - 1]
            energy += diff if diff >= 0 else -diff
        envelope.append(math.log1p(energy / span))
    return envelope


def _flux(envelope: Sequence[float]) -> list[float]:
    rises = [0.0] * len(envelope)
    for k in range(1, len(envelope)):
        rise = envelope[k] - envelope[k - 1]
        if rise > 0:
            rises[k] = rise
    return rises


def pick_transients(flux: Sequence[float], samples: Sequence[int]) -> list[float]:
    """Onset times in seconds, refined to the loudest sample in each window."""
    if not flux:
        return []
    peak = max(flux)
    if peak <= FLUX_FLOOR:
        return []
    middle = median(flux)
    threshold = middle + max(0.3 * (peak - middle), FLUX_FLOOR)
    last = len(flux) - 1
    candidates = [
        k
        for k in range(1, len(flux))
        if flux[k] > threshold
        and flux[k] >= flux[k - 1]
        and (k == last or flux[k] > flux[k + 1])
    ]
    candidates.sort(key=lambda k: flux[k], reverse=True)
    taken: list[int] = []
    for k in candidates:
        if all(abs(k - other) >= MIN_PEAK_GAP for other in taken):
            taken.append(k)
    times: list[float] = []
    for k in sorted(taken):
        low = max(k * HOP, 1)
        high = min(k * HOP + WINDOW, len(samples))
        best = low
        best_mag = -1
        for i in range(low, high):
            mag = abs(samples[i] - samples[i - 1])
            if mag > best_mag:
                best_mag = mag
                best = i
        times.append(round(best / SAMPLE_RATE, 3))
    return sorted(times)


def estimate_tempo(transients: Sequence[float]) -> tuple[float | None, float]:
    """Global tempo in BPM plus confidence in 0..1 (None when unsure)."""
    pairs = zip(transients, transients[1:], strict=False)
    gaps = sorted(later - earlier for earlier, later in pairs if later > earlier)
    if len(gaps) < MIN_CLUSTER_IOIS:
        return None, 0.0
    clusters: list[list[float]] = []
    for gap in gaps:
        if clusters and abs(gap - median(clusters[-1])) <= IOI_TOLERANCE * median(clusters[-1]):
            clusters[-1].append(gap)
        else:
            clusters.append([gap])
    best = max(clusters, key=lambda c: (len(c), MIN_BPM <= 60 / median(c) <= MAX_BPM))
    fraction = len(best) / len(gaps)
    if len(best) < MIN_CLUSTER_IOIS or fraction < MIN_CLUSTER_FRACTION:
        return None, round(fraction, 3)
    bpm = 60 / median(best)
    while bpm < MIN_BPM:  # octave fold: subdivisions land on the beat
        bpm *= 2
    while bpm > MAX_BPM:
        bpm /= 2
    return round(bpm, 1), round(min(1.0, fraction), 3)


def beat_grid(
    flux: Sequence[float],
    transients: Sequence[float],
    bpm: float | None,
    duration: float,
) -> list[float]:
    """Beat times in seconds, anchored at the strongest onset, snapped nearby."""
    if bpm is None or bpm <= 0 or duration <= 0 or not flux:
        return []
    peak_frame = max(range(len(flux)), key=lambda k: flux[k])
    peak_time = peak_frame * HOP / SAMPLE_RATE
    anchor = min(transients, key=lambda t: abs(t - peak_time)) if transients else peak_time
    period = 60.0 / bpm
    beats: list[float] = []
    n = math.ceil((0.0 - anchor) / period) - 1
    while True:
        grid = anchor + n * period
        if grid - SNAP_WINDOW > duration:
            break
        if grid + SNAP_WINDOW >= 0:
            near = min(transients, key=lambda t: abs(t - grid), default=None)
            if near is not None and abs(near - grid) <= SNAP_WINDOW:
                grid = near
            if 0 <= grid < duration:
                beats.append(round(grid, 3))
        n += 1
    return beats


def analyze(samples: Sequence[int], *, duration: float) -> dict:
    """Beat grid, transients, and tempo for mono SAMPLE_RATE PCM samples."""
    envelope = onset_envelope(samples)
    flux = _flux(envelope)
    transients = pick_transients(flux, samples)
    bpm, confidence = estimate_tempo(transients)
    return {
        "tempo_bpm": bpm,
        "tempo_confidence": confidence,
        "transients": transients,
        "beats": beat_grid(flux, transients, bpm, duration),
    }


def _marker(
    kind: str, time: float, name: str, color: str, note: str, fps: float | None
) -> dict:
    marker: dict[str, object] = {
        "kind": kind,
        "time": time,
        "name": name,
        "color": color,
        "note": note,
    }
    if fps is not None:
        marker["frame"] = int(round(time * fps))
    return marker


def build_markers(
    *,
    beats: Sequence[float],
    transients: Sequence[float],
    words: Sequence[dict],
    tempo_bpm: float | None,
    fps: float | None,
) -> list[dict]:
    """Import-ready timeline markers (Resolve color names, frame ids on fps)."""
    tempo = f"{tempo_bpm:.1f} BPM" if tempo_bpm is not None else ""
    markers = [
        _marker("beat", time, f"Beat {index + 1}", "Blue", tempo, fps)
        for index, time in enumerate(beats)
    ]
    markers.extend(
        _marker("transient", time, "Transient", "Yellow", "onset", fps) for time in transients
    )
    markers.extend(
        _marker("word", word["start"], word["word"], "Green", f"ends at {word['end']:.3f}s", fps)
        for word in words
    )
    markers.sort(key=lambda marker: (marker["time"], marker["kind"]))
    return markers
