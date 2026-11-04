"""Tiny curated SFX synthesizer: risers, tape stops, whooshes, impacts.

Stdlib only (`wave`, `math`, `random`): no licensed assets, no downloads,
no new dependencies. Each kind is one tasteful shape at a negative-friendly
level, with short fades so nothing clicks. Files land in the sidecar proxy
cache through the `synth_sfx` job; source media is never touched.
"""

import math
import random
import wave
from pathlib import Path

SAMPLE_RATE = 44100

#: Default lengths in seconds. Risers are long enough to breathe into a cut.
DEFAULT_DURATIONS = {
    "riser": 2.0,
    "tape-stop": 1.2,
    "whoosh": 0.8,
    "impact": 1.5,
}

KINDS = tuple(DEFAULT_DURATIONS)

_FADE = 0.005


def _fade(samples: list[float], rate: int = SAMPLE_RATE) -> None:
    span = max(1, int(_FADE * rate))
    for i in range(min(span, len(samples))):
        gain = i / span
        samples[i] *= gain
        samples[-(i + 1)] *= gain


def _noise(rng: random.Random, count: int) -> list[float]:
    return [rng.uniform(-1.0, 1.0) for _ in range(count)]


def _normalize(samples: list[float], peak: float = 0.89) -> None:
    loudest = max((abs(v) for v in samples), default=0.0)
    if loudest <= 0:
        return
    gain = peak / loudest
    for i, value in enumerate(samples):
        samples[i] = value * gain


def _sweep_up(count: int, start_hz: float, end_hz: float) -> list[float]:
    """Sine sweep rising start_hz -> end_hz with an exponential ramp feel."""
    samples = [0.0] * count
    phase = 0.0
    for i in range(count):
        frac = i / max(count - 1, 1)
        freq = start_hz * (end_hz / start_hz) ** frac
        phase += 2.0 * math.pi * freq / SAMPLE_RATE
        samples[i] = math.sin(phase) * frac**1.5
    return samples


def _sweep_down(count: int, start_hz: float, end_hz: float) -> list[float]:
    """Sine sweep falling start_hz -> end_hz, loud at the top, dying out."""
    samples = [0.0] * count
    phase = 0.0
    for i in range(count):
        frac = i / max(count - 1, 1)
        freq = start_hz * (end_hz / start_hz) ** frac
        phase += 2.0 * math.pi * freq / SAMPLE_RATE
        samples[i] = math.sin(phase) * (1.0 - frac) ** 1.5
    return samples


def _whoosh(count: int, rng: random.Random) -> list[float]:
    """Noise swell peaking mid-file through a sweeping one-pole lowpass."""
    raw = _noise(rng, count)
    out = [0.0] * count
    state = 0.0
    for i in range(count):
        frac = i / max(count - 1, 1)
        # Cutoff sweeps up then down; envelope swells then releases.
        cutoff = 0.02 + 0.30 * math.sin(math.pi * frac)
        state += cutoff * (raw[i] - state)
        out[i] = state * math.sin(math.pi * frac) ** 0.7
    return out


def _impact(count: int, rng: random.Random) -> list[float]:
    """Low thump (55 Hz decay) plus a short noise attack."""
    out = [0.0] * count
    attack = _noise(rng, count)
    for i in range(count):
        frac = i / max(count - 1, 1)
        body = math.sin(2.0 * math.pi * 55.0 * i / SAMPLE_RATE) * math.exp(-4.0 * frac)
        click = attack[i] * math.exp(-60.0 * frac)
        out[i] = body * 0.9 + click * 0.35
    return out


_BUILDERS = {
    "riser": lambda count, rng: _sweep_up(count, 180.0, 2200.0),
    "tape-stop": lambda count, rng: _sweep_down(count, 750.0, 55.0),
    "whoosh": _whoosh,
    "impact": _impact,
}


def render_samples(kind: str, duration: float, *, seed: int = 7) -> list[float]:
    """Render one SFX shape as mono float samples. Raises on bad input."""
    if kind not in _BUILDERS:
        raise ValueError(f"synth knows {', '.join(KINDS)}: not {kind!r}")
    if not 0.3 <= duration <= 8.0:
        raise ValueError("synth duration stays within 0.3-8.0 seconds")
    count = max(1, int(round(duration * SAMPLE_RATE)))
    rng = random.Random(f"{kind}:{seed}")
    samples = _BUILDERS[kind](count, rng)
    _fade(samples)
    _normalize(samples)
    return samples


def write_wav(dest: Path, samples: list[float], rate: int = SAMPLE_RATE) -> Path:
    """Write mono 16-bit WAV next to nothing it could overwrite. Returns dest."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    clamped = [max(-1.0, min(1.0, v)) for v in samples]
    frames = b"".join(int(v * 32767).to_bytes(2, "little", signed=True) for v in clamped)
    with wave.open(str(dest), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(frames)
    return dest


def synthesize(kind: str, dest: Path, *, duration: float | None = None) -> dict:
    """Render `kind` to `dest`. Returns the job-result payload."""
    seconds = DEFAULT_DURATIONS[kind] if duration is None else duration
    if kind not in _BUILDERS:
        raise ValueError(f"synth knows {', '.join(KINDS)}: not {kind!r}")
    samples = render_samples(kind, seconds)
    write_wav(dest, samples)
    return {
        "path": str(dest),
        "kind": kind,
        "duration_seconds": round(len(samples) / SAMPLE_RATE, 3),
        "sample_rate": SAMPLE_RATE,
    }


def tape_stop_tail(
    samples: list[int],
    rate: int,
    *,
    window_seconds: float,
) -> list[float]:
    """Slow a mono int16 tail from full speed to a dead stop.

    Linear slowdown 1 -> 0 over an output twice the window: the output
    consumes exactly the window and the pitch falls to nothing, plus a
    short fade so the file ends silent. Pure python; windows are short.
    """
    window = max(1, int(round(window_seconds * rate)))
    tail = [v / 32768.0 for v in samples[-window:]]
    out_len = 2 * len(tail)
    out = [0.0] * out_len
    for i in range(out_len):
        frac = i / max(out_len - 1, 1)
        # Position with speed (1 - frac): pos = window * (frac - frac^2 / 2) * 2
        pos = (len(tail) - 1) * (2.0 * frac - frac * frac)
        low = int(pos)
        high = min(low + 1, len(tail) - 1)
        blend = pos - low
        out[i] = tail[low] * (1.0 - blend) + tail[high] * blend
    _fade(out, rate)
    _normalize(out, peak=0.89)
    return out
