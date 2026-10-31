import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

PREVIEW_PRESET = "preview-640"
PREVIEW_WIDTH = 640
DEFAULT_SCENE_THRESHOLD = 0.4
DEFAULT_MIN_SHOT = 0.0


class JobKind(StrEnum):
    SAM3_MASK = "sam3_mask"
    SAM3D = "sam3d"
    SAM_AUDIO = "sam_audio"
    PROXY = "proxy"
    FRAME = "frame"
    MEASURE_AUDIO = "measure_audio"
    SCENE_CUTS = "scene_cuts"


FFMPEG_TOOLS: dict[str, JobKind] = {
    "render_preview": JobKind.PROXY,
    "get_frame": JobKind.FRAME,
    "measure_audio": JobKind.MEASURE_AUDIO,
    "detect_scenes": JobKind.SCENE_CUTS,
}


# Model tools shell out to programs outside the repo; weights never live here.
# sam3_mask protocol: `$CHAIR_SAM3_RUNNER --source <media> --prompt <json>
# --output <matte.mp4>`. The prompt json is {"kind": "text", "prompt": "..."}
# or {"kind": "point", "point": [x, y]} with x, y in 0..1. The runner writes
# `progress=0..1` lines to stderr and exits 0 with a video file at --output.
MODEL_TOOLS: dict[str, JobKind] = {
    "sam3_mask": JobKind.SAM3_MASK,
}


def _checked_source(value: str) -> str:
    if not value.strip():
        raise ValueError("source is required")
    return value


class MediaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    time: float | None = None
    threshold: float | None = None
    min_shot: float | None = None

    @field_validator("source")
    @classmethod
    def source_not_blank(cls, value: str) -> str:
        return _checked_source(value)

    @field_validator("time")
    @classmethod
    def time_non_negative(cls, value: float | None) -> float | None:
        if value is not None and value < 0:
            raise ValueError("time must be >= 0")
        return value

    @field_validator("threshold")
    @classmethod
    def threshold_in_range(cls, value: float | None) -> float | None:
        if value is not None and not 0 <= value <= 1:
            raise ValueError("threshold must sit between 0 and 1")
        return value

    @field_validator("min_shot")
    @classmethod
    def min_shot_non_negative(cls, value: float | None) -> float | None:
        if value is not None and value < 0:
            raise ValueError("min_shot must be >= 0")
        return value


class Sam3Request(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    prompt_kind: Literal["text", "point"] = "text"
    prompt: str | None = None
    point: tuple[float, float] | None = None

    @field_validator("source")
    @classmethod
    def source_not_blank(cls, value: str) -> str:
        return _checked_source(value)

    @model_validator(mode="after")
    def prompt_matches_kind(self) -> "Sam3Request":
        if self.prompt_kind == "text":
            if self.prompt is None or not self.prompt.strip():
                raise ValueError("text prompts need prompt")
        else:
            if self.point is None:
                raise ValueError("point prompts need point")
            if any(not 0.0 <= axis <= 1.0 for axis in self.point):
                raise ValueError("point must be within 0..1")
        return self

    def prompt_payload(self) -> dict:
        payload: dict[str, object] = {"kind": self.prompt_kind}
        if self.prompt is not None:
            payload["prompt"] = self.prompt
        if self.point is not None:
            payload["point"] = list(self.point)
        return payload


@dataclass
class JobRecord:
    id: str
    tool: str
    kind: str
    status: str
    progress: float
    result: dict | None = None
    error: str | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "tool": self.tool,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
        }


def default_proxy_dir() -> Path:
    configured = os.environ.get("CHAIR_PROXY_DIR")
    if configured:
        path = Path(configured).expanduser()
    else:
        root = Path(os.environ.get("CHAIR_ROOT", ".")).expanduser()
        path = root / "data" / "proxies"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def binary(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} is not on PATH")
    return found


def sam3_runner() -> str | None:
    configured = os.environ.get("CHAIR_SAM3_RUNNER", "").strip()
    return configured or None


def parse_progress(line: str, duration: float) -> float | None:
    # out_time_ms is microseconds in ffmpeg. out_time_us is the clock.
    stripped = line.strip()
    if not stripped.startswith("out_time_us="):
        return None
    raw = stripped.split("=", 1)[1]
    if raw == "N/A" or duration <= 0:
        return None
    fraction = int(raw) / (duration * 1_000_000)
    return min(max(fraction, 0.0), 0.99)


def parse_runner_progress(line: str) -> float | None:
    stripped = line.strip()
    if not stripped.startswith("progress="):
        return None
    try:
        fraction = float(stripped.split("=", 1)[1])
    except ValueError:
        return None
    return min(max(fraction, 0.0), 0.99)


def parse_ebur128(log: str) -> dict[str, float]:
    summary_at = log.rfind("Summary:")
    if summary_at < 0:
        raise RuntimeError("ffmpeg did not report loudness")
    summary = log[summary_at:]
    integrated = re.search(r"I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", summary)
    loudness_range = re.search(r"LRA:\s+(-?\d+(?:\.\d+)?)\s+LU\b", summary)
    peaks = [float(value) for value in re.findall(r"Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", summary)]
    if integrated is None or loudness_range is None or not peaks:
        raise RuntimeError("ffmpeg did not report loudness")
    return {
        "integrated_lufs": float(integrated.group(1)),
        "loudness_range_lu": float(loudness_range.group(1)),
        "true_peak_dbfs": max(peaks),
    }


def parse_silence(log: str, duration: float) -> list[dict[str, float]]:
    starts = [float(value) for value in re.findall(r"silence_start:\s+(-?\d+(?:\.\d+)?)", log)]
    ends = [float(value) for value in re.findall(r"silence_end:\s+(-?\d+(?:\.\d+)?)", log)]
    spans: list[dict[str, float]] = []
    for index, start in enumerate(starts):
        end = ends[index] if index < len(ends) else duration
        spans.append({"start": round(start, 3), "end": round(min(end, duration), 3)})
    return spans


def parse_scene_cuts(log: str, duration: float, *, min_shot: float = 0.0) -> list[float]:
    times = sorted(
        {round(float(value), 3) for value in re.findall(r"pts_time:([0-9]+(?:\.[0-9]+)?)", log)}
    )
    cuts = [moment for moment in times if 0 < moment < duration]
    kept: list[float] = []
    for cut in cuts:
        if not kept or cut - kept[-1] >= min_shot:
            kept.append(cut)
    return kept


def active_spans(silence: list[dict[str, float]], duration: float) -> list[dict[str, float]]:
    spans: list[dict[str, float]] = []
    cursor = 0.0
    for span in silence:
        if span["start"] > cursor + 0.001:
            spans.append({"start": round(cursor, 3), "end": round(span["start"], 3)})
        cursor = max(cursor, span["end"])
    if duration > cursor + 0.001:
        spans.append({"start": round(cursor, 3), "end": round(duration, 3)})
    return spans


def _cache_key(source: Path, *parts: str) -> str:
    stat = source.stat()
    payload = "\0".join((str(source), str(stat.st_size), str(stat.st_mtime_ns), *parts))
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _fingerprint(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


def _tail(text: str) -> str:
    cleaned = text.strip()
    return cleaned[-500:]


class JobStore:
    def __init__(self, proxy_dir: Path) -> None:
        self.proxy_dir = proxy_dir.resolve()
        self.proxy_dir.mkdir(parents=True, exist_ok=True)
        self._path = self.proxy_dir / "jobs.json"
        self._jobs: dict[str, JobRecord] = {}
        self._lock = threading.Lock()
        self._load()

    def submit(self, tool: str, request: MediaRequest | Sam3Request) -> dict:
        if tool in FFMPEG_TOOLS:
            if not isinstance(request, MediaRequest):
                raise ValueError(f"{tool} needs source and time fields")
            kind = FFMPEG_TOOLS[tool]
            if tool == "get_frame" and request.time is None:
                raise ValueError("get_frame requires time")
            time_s = request.time
            threshold = (
                request.threshold if request.threshold is not None else DEFAULT_SCENE_THRESHOLD
            )
            min_shot = request.min_shot if request.min_shot is not None else DEFAULT_MIN_SHOT
            prompt: dict | None = None
        elif tool in MODEL_TOOLS:
            if not isinstance(request, Sam3Request):
                raise ValueError(f"{tool} needs source and prompt fields")
            kind = MODEL_TOOLS[tool]
            time_s = None
            threshold = DEFAULT_SCENE_THRESHOLD
            min_shot = DEFAULT_MIN_SHOT
            prompt = request.prompt_payload()
        else:
            raise ValueError(f"unknown tool: {tool}")
        source = Path(request.source).expanduser().resolve()
        if not source.is_file():
            raise ValueError(f"source is not a file: {source}")
        job = JobRecord(
            id=uuid.uuid4().hex,
            tool=tool,
            kind=kind.value,
            status="queued",
            progress=0.0,
        )
        with self._lock:
            self._jobs[job.id] = job
            self._save()
            snapshot = job.public()
        threading.Thread(
            target=self._run,
            args=(job.id, tool, source, time_s, prompt, threshold, min_shot),
            daemon=True,
        ).start()
        return snapshot

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else job.public()

    def _update(self, job_id: str, **fields: object) -> None:
        with self._lock:
            job = self._jobs[job_id]
            for key, value in fields.items():
                setattr(job, key, value)
            self._save()

    def _load(self) -> None:
        # No requeue: a restart reports the last known state, it never re-runs.
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            jobs = {key: JobRecord(**value) for key, value in raw["jobs"].items()}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return
        self._jobs = jobs

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"jobs": {key: job.public() for key, job in self._jobs.items()}}),
            encoding="utf-8",
        )
        tmp.replace(self._path)

    def _run(
        self,
        job_id: str,
        tool: str,
        source: Path,
        time_s: float | None,
        prompt: dict | None,
        threshold: float = DEFAULT_SCENE_THRESHOLD,
        min_shot: float = DEFAULT_MIN_SHOT,
    ) -> None:
        self._update(job_id, status="running")
        before = _fingerprint(source)
        try:
            if tool == "render_preview":
                result = self._render_preview(job_id, source)
            elif tool == "get_frame":
                if time_s is None:
                    raise RuntimeError("get_frame requires time")
                result = self._get_frame(job_id, source, time_s)
            elif tool == "detect_scenes":
                result = self._detect_scenes(job_id, source, threshold, min_shot)
            elif tool == "sam3_mask":
                if prompt is None:
                    raise RuntimeError("sam3_mask requires a prompt")
                result = self._track_matte(job_id, source, prompt)
            else:
                result = self._measure_audio(job_id, source)
            if _fingerprint(source) != before:
                raise RuntimeError("source media changed during the job")
        except Exception as exc:
            self._update(job_id, status="failed", error=str(exc) or exc.__class__.__name__)
            return
        self._update(job_id, status="done", progress=1.0, result=result, error=None)

    def _render_preview(self, job_id: str, source: Path) -> dict:
        info = self._probe(source)
        if _video_size(info) is None:
            raise RuntimeError("source has no video stream")
        dest = self._output(source, f"preview-{_cache_key(source, PREVIEW_PRESET)}.mp4")
        cached = self._probe_if_ready(dest)
        if cached is not None:
            return _picture_result(cached, proxy=str(dest), preset=PREVIEW_PRESET, cached=True)
        part = self._part(dest, job_id)
        args = [
            "-i",
            str(source),
            "-vf",
            f"scale={PREVIEW_WIDTH}:-2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
        ]
        if _has_stream(info, "audio"):
            args.extend(["-c:a", "aac", "-b:a", "96k"])
        else:
            args.append("-an")
        args.extend(["-movflags", "+faststart", "-y", str(part)])
        try:
            self._ffmpeg(job_id, args, _duration(info))
            os.replace(part, dest)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        return _picture_result(
            self._probe(dest),
            proxy=str(dest),
            preset=PREVIEW_PRESET,
            cached=False,
        )

    def _get_frame(self, job_id: str, source: Path, time_s: float) -> dict:
        info = self._probe(source)
        if _video_size(info) is None:
            raise RuntimeError("source has no video stream")
        duration = _duration(info)
        if time_s > duration:
            raise RuntimeError(f"time {time_s} is past duration {duration}")
        dest = self._output(source, f"frame-{_cache_key(source, f'{time_s:.3f}')}.jpg")
        cached = self._probe_if_ready(dest)
        if cached is not None:
            width, height = _video_size(cached) or (0, 0)
            return {
                "frame": str(dest),
                "time": time_s,
                "width": width,
                "height": height,
                "cached": True,
            }
        part = self._part(dest, job_id)
        args = [
            "-i",
            str(source),
            "-ss",
            f"{time_s:.6f}",
            "-frames:v",
            "1",
            "-q:v",
            "2",
            "-y",
            str(part),
        ]
        try:
            self._ffmpeg(job_id, args, duration)
            os.replace(part, dest)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        width, height = _video_size(self._probe(dest)) or (0, 0)
        return {
            "frame": str(dest),
            "time": time_s,
            "width": width,
            "height": height,
            "cached": False,
        }

    def _measure_audio(self, job_id: str, source: Path) -> dict:
        info = self._probe(source)
        if not _has_stream(info, "audio"):
            raise RuntimeError("source has no audio stream")
        duration = _duration(info)
        log = self._ffmpeg(
            job_id,
            [
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-af",
                "ebur128=peak=true,silencedetect=noise=-30dB:d=0.2",
                "-f",
                "null",
                "-",
            ],
            duration,
        )
        loudness = parse_ebur128(log)
        silence = parse_silence(log, duration)
        return {
            **loudness,
            "duration": duration,
            "silence": silence,
            "active": active_spans(silence, duration),
        }

    def _detect_scenes(
        self, job_id: str, source: Path, threshold: float, min_shot: float
    ) -> dict:
        info = self._probe(source)
        if _video_size(info) is None:
            raise RuntimeError("source has no video stream")
        duration = _duration(info)
        log = self._ffmpeg(
            job_id,
            [
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-vf",
                f"select='gt(scene,{threshold})',showinfo",
                "-f",
                "null",
                "-",
            ],
            duration,
        )
        return {
            "cuts": parse_scene_cuts(log, duration, min_shot=min_shot),
            "duration": duration,
            "threshold": threshold,
            "min_shot": min_shot,
        }

    def _track_matte(self, job_id: str, source: Path, prompt: dict) -> dict:
        runner = sam3_runner()
        if runner is None:
            raise RuntimeError("CHAIR_SAM3_RUNNER is not set; SAM 3 weights run outside the repo")
        info = self._probe(source)
        if _video_size(info) is None:
            raise RuntimeError("source has no video stream")
        key = _cache_key(source, "sam3", json.dumps(prompt, sort_keys=True))
        dest = self._output(source, f"matte-{key}.mp4")
        cached = self._probe_if_ready(dest)
        if cached is not None:
            return _matte_result(
                cached, source=str(source), prompt=prompt, matte=str(dest), cached=True
            )
        part = self._part(dest, job_id)
        command = [
            runner,
            "--source",
            str(source),
            "--prompt",
            json.dumps(prompt),
            "--output",
            str(part),
        ]
        try:
            self._run_runner(job_id, command)
            if _video_size(self._probe(part)) is None:
                raise RuntimeError("sam3 runner output has no video stream")
            os.replace(part, dest)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        return _matte_result(
            self._probe(dest), source=str(source), prompt=prompt, matte=str(dest), cached=False
        )

    def _ffmpeg(self, job_id: str, args: list[str], duration: float) -> str:
        command = [
            binary("ffmpeg"),
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-progress",
            "pipe:2",
            *args,
        ]
        return self._run_command(
            job_id, command, lambda line: parse_progress(line, duration), what="ffmpeg"
        )

    def _run_runner(self, job_id: str, command: list[str]) -> str:
        return self._run_command(job_id, command, parse_runner_progress, what="sam3 runner")

    def _run_command(
        self,
        job_id: str,
        command: list[str],
        parse: Callable[[str], float | None],
        *,
        what: str,
    ) -> str:
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as exc:
            raise RuntimeError(f"{what} failed to start: {exc}") from exc
        lines: list[str] = []
        assert process.stderr is not None
        for line in process.stderr:
            lines.append(line)
            fraction = parse(line)
            if fraction is not None:
                self._update(job_id, progress=round(fraction, 4))
        code = process.wait()
        log = "".join(lines)
        if code != 0:
            raise RuntimeError(_tail(log) or f"{what} exited {code}")
        return log

    def _probe(self, path: Path) -> dict:
        completed = subprocess.run(
            [
                binary("ffprobe"),
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise RuntimeError(_tail(completed.stderr) or "ffprobe failed")
        return json.loads(completed.stdout)

    def _probe_if_ready(self, path: Path) -> dict | None:
        if not path.is_file() or path.stat().st_size == 0:
            return None
        try:
            return self._probe(path)
        except (RuntimeError, json.JSONDecodeError):
            return None

    def _output(self, source: Path, name: str) -> Path:
        path = (self.proxy_dir / name).resolve()
        if self.proxy_dir not in path.parents:
            raise RuntimeError("refusing to write outside the proxy cache")
        if path == source:
            raise RuntimeError("refusing to overwrite source media")
        return path

    def _part(self, dest: Path, job_id: str) -> Path:
        return dest.with_name(f"{dest.stem}.{job_id}.part{dest.suffix}")


def _has_stream(info: dict, kind: str) -> bool:
    return any(stream.get("codec_type") == kind for stream in info.get("streams", []))


def _duration(info: dict) -> float:
    raw = info.get("format", {}).get("duration")
    if raw is None:
        raise RuntimeError("media has no duration")
    duration = float(raw)
    if duration <= 0:
        raise RuntimeError("media duration is zero")
    return duration


def _video_size(info: dict) -> tuple[int, int] | None:
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video" and stream.get("width") and stream.get("height"):
            return int(stream["width"]), int(stream["height"])
    return None


def _picture_result(info: dict, *, proxy: str, preset: str, cached: bool) -> dict:
    width, height = _video_size(info) or (0, 0)
    return {
        "proxy": proxy,
        "preset": preset,
        "width": width,
        "height": height,
        "duration": _duration(info),
        "cached": cached,
    }


def _matte_result(
    info: dict, *, source: str, prompt: dict, matte: str, cached: bool
) -> dict:
    width, height = _video_size(info) or (0, 0)
    return {
        "matte": matte,
        "source": source,
        "prompt_kind": prompt.get("kind"),
        "width": width,
        "height": height,
        "duration": _duration(info),
        "cached": cached,
    }
