"""Plan, execute, verify: one brief in, one gated proposal out.

run_loop plans the brief, fills tool calls, builds the pending changeset,
and verifies the preview. show_to_ui is True only when the verifier
accepts; a rejection keeps the preview away from the UI.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from chair_agent import sounds
from chair_agent.beats import StoryPlan
from chair_agent.client import ModelClient
from chair_agent.dispatch import (
    PreviewRenderer,
    SilenceMeasurer,
    build_sidecar_tools,
    dispatch_spans_with_notes,
)
from chair_agent.edit_ops import build_changeset
from chair_agent.executor import (
    SfxFile,
    SkippedIntent,
    Span,
    ToolCall,
    canonical_intent,
    canonical_intents,
    cuts_to_changeset,
    fill_tool_calls,
    sound_changeset_items,
)
from chair_agent.jobs import HandlerResult, Job
from chair_agent.planner import DISPATCHABLE_INTENTS, SOUND_INTENTS, Plan, plan_brief
from chair_agent.style import StyleProfile
from chair_agent.transcribe import TranscriptionAdapter, build_transcription_adapter
from chair_agent.verifier import AudioEvidence, FrameEvidence, Verdict, verify

_EXECUTOR_TOOLS = frozenset({"measure_audio", "transcribe", "editor_op", "render_preview"})


class LoopContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    proxy_url: str
    base_revision: str
    target_id: str
    changeset_id: str
    total_frames: int
    rate: float = 30.0


class LoopResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    plan: Plan
    tool_calls: list[ToolCall]
    changeset: dict[str, Any]
    verdict: Verdict
    show_to_ui: bool
    skipped: list[SkippedIntent] = Field(default_factory=list)
    message: str | None = Field(default=None, exclude=True)


class PreviewRejected(Exception):
    def __init__(self, reasons: list[str]) -> None:
        self.reasons = reasons
        super().__init__("; ".join(reasons) or "preview rejected")


def run_loop(
    brief: str,
    context: LoopContext,
    spans: list[Span],
    *,
    artifact_urls: list[str],
    plan: StoryPlan | Mapping[str, Any] | None = None,
    style: StyleProfile | Mapping[str, Any] | None = None,
    frames: Sequence[FrameEvidence | Mapping[str, Any]] = (),
    audio: AudioEvidence | Mapping[str, Any] | None = None,
    client: ModelClient | None = None,
    planned: Plan | None = None,
    sfx: dict[str, SfxFile] | None = None,
    sfx_errors: list[SkippedIntent] | None = None,
) -> LoopResult:
    """Run plan, execute, verify for one brief against the proxy.

    The beat sheet, style profile, and frame/audio evidence are
    optional: absent, the mechanical verdict stands alone as before.
    Sound intents dispatch to SFX and ducking items; anything the
    executor cannot dispatch comes back in `skipped` with a plain
    reason instead of silently vanishing from the job.
    """
    if planned is None:
        planned = plan_brief(brief, client=client)
    canon = canonical_intents(planned.intents)
    executable_plan = Plan(
        brief=planned.brief,
        intents=[i for i in canon if i in DISPATCHABLE_INTENTS],
        steps=[s for s in planned.steps if s.tool in _EXECUTOR_TOOLS],
    )
    tool_calls = fill_tool_calls(executable_plan, spans, proxy_url=context.proxy_url)
    cuts = cuts_to_changeset(
        spans,
        changeset_id=context.changeset_id,
        base_revision=context.base_revision,
        target_id=context.target_id,
        brief=brief,
        intents=list(executable_plan.intents),
    )
    sound_items, sound_skipped = sound_changeset_items(
        brief,
        list(executable_plan.intents),
        spans,
        total_frames=context.total_frames,
        rate=context.rate,
        sfx=sfx or {},
        duck_target_id=context.target_id,
    )
    skipped = _merge_skipped(sfx_errors or [], sound_skipped)
    skipped.extend(
        SkippedIntent(intent=intent, reason=f"Chair cannot dispatch {intent} yet")
        for intent in planned.intents
        if canonical_intent(intent) not in DISPATCHABLE_INTENTS
    )
    combined = build_changeset(
        context.changeset_id,
        context.base_revision,
        [*cuts.items, *sound_items],
        summary=brief,
    )
    dumped = combined.model_dump(mode="json", by_alias=True, exclude_none=True)
    verdict = verify(
        dumped,
        artifact_urls=artifact_urls,
        total_frames=context.total_frames,
        plan=plan,
        style=style,
        frames=frames,
        audio=audio,
    )
    return LoopResult(
        plan=planned,
        tool_calls=tool_calls,
        changeset=dumped,
        verdict=verdict,
        show_to_ui=verdict.accepted,
        skipped=skipped,
        message=planned.message,
    )


def _merge_skipped(
    first: list[SkippedIntent], second: list[SkippedIntent]
) -> list[SkippedIntent]:
    """Combine skipped lists; the first reason per intent wins."""
    seen = {skip.intent for skip in first}
    return [*first, *[skip for skip in second if skip.intent not in seen]]


def _intent_for_kind(kind: str) -> str:
    return {"riser": "riser_into_cut", "tape-stop": "tape_stop_outro"}[kind]


def _resolve_sfx_files(
    intents: list[str],
    *,
    proxy_url: str,
    total_frames: int,
    rate: float,
    synth_url: str | None,
) -> tuple[dict[str, SfxFile], list[SkippedIntent]]:
    """Resolve one SFX file per needed kind: library first, sidecar synth.

    Tape stops prefer a render of the program tail through the sidecar;
    anything else synthesizes a sweep from scratch. Failures come back as
    skipped entries with the plain reason; the executor reports files that
    stay missing after all that.
    """
    from pathlib import Path

    from chair_agent import sounds

    wanted = [intent for intent in canonical_intents(intents) if intent in SOUND_INTENTS]
    if not wanted:
        return {}, []
    entries = sounds.get_library()
    kinds: list[str] = []
    if "riser_into_cut" in wanted:
        kinds.append("riser")
    if "tape_stop_outro" in wanted:
        kinds.append("tape-stop")
    total_seconds = total_frames / rate if total_frames > 0 and rate > 0 else 0.0
    files: dict[str, SfxFile] = {}
    errors: list[SkippedIntent] = []
    for kind in kinds:
        entry = sounds.sfx_for_kind(entries, kind)
        if entry is None and synth_url:
            try:
                if kind == "tape-stop" and total_seconds > 0:
                    entry = sounds.render_tape_stop_entry(
                        synth_url, proxy_url,
                        at_seconds=max(0.0, total_seconds - 1.5),
                    )
                else:
                    entry = sounds.fetch_synth_entry(kind, synth_url)
            except Exception as error:
                errors.append(SkippedIntent(
                    intent=_intent_for_kind(kind),
                    reason=f"sound render failed: {error}",
                ))
                continue
        if entry is None:
            continue
        duration = entry.duration
        if duration is None:
            duration = sounds.probe_duration(Path(entry.path))
        if duration is None or duration <= 0:
            errors.append(SkippedIntent(
                intent=_intent_for_kind(kind),
                reason=f"could not read the length of {entry.name}",
            ))
            continue
        files[kind] = SfxFile(
            kind=kind,
            path=entry.path,
            name=entry.name,
            duration_seconds=round(duration, 3),
            source=entry.source,
            license=entry.license,
        )
    return files, errors


def _resolve_timeline_media(timeline: Mapping[str, Any]) -> tuple[str, int, str]:
    proxy_url = ""
    for track in timeline.get("tracks", []):
        for clip in track.get("clips", []):
            ref = clip.get("mediaRef")
            if isinstance(ref, str) and ref.strip():
                proxy_url = ref.strip()
                break
        if proxy_url:
            break

    rate_info = timeline.get("rate") or {}
    num = rate_info.get("num", 30)
    den = rate_info.get("den", 1)
    fps = num / den if den else 30.0

    total_frames = 0
    for track in timeline.get("tracks", []):
        for clip in track.get("clips", []):
            tr = clip.get("timelineRange") or clip.get("sourceRange") or {}
            start = tr.get("start") or {}
            duration = tr.get("duration") or {}
            s_val = start.get("value", 0)
            s_rate = start.get("rate", fps)
            d_val = duration.get("value", 0)
            d_rate = duration.get("rate", fps)
            end_s = (s_val / s_rate if s_rate else 0) + (d_val / d_rate if d_rate else 0)
            clip_frames = int(round(end_s * fps))
            if clip_frames > total_frames:
                total_frames = clip_frames

    target_id = str(timeline.get("id") or "")
    return proxy_url, total_frames, target_id


def _has_dispatchable_intent(planned: Plan) -> bool:
    """True when the cut/sound pipeline can dispatch at least one intent."""
    return any(
        intent in DISPATCHABLE_INTENTS
        for intent in canonical_intents(planned.intents)
    )


def _handle_crew_brief(
    brief: str,
    *,
    client: ModelClient | None,
    model: str | None,
    changeset_id: str,
    base_revision: str,
    target_id: str,
    total_frames: int,
) -> HandlerResult:
    """Fall-through for briefs the cut/sound pipeline can't plan: one crew run.

    The desktop still submitted task "edit", so the result keeps the shape
    it expects: pending ops plus a planner tag. A brief the crew also
    can't do raises a plain ValueError, never a stack trace.
    """
    from chair_agent.client import build_client, build_client_for_model
    from chair_agent.crew.orchestrator import run_crew

    use_client = client
    if use_client is None:
        try:
            use_client = build_client_for_model(model)
        except Exception:
            use_client = None
        if use_client is None:
            use_client = build_client()
    synth_plan = {"beats": [{"id": "b1", "intent": brief[:280]}]}
    try:
        run = run_crew(
            brief,
            synth_plan,
            client=use_client,
            changeset_id=changeset_id,
            base_revision=base_revision,
            target_id=target_id,
            total_frames=total_frames,
        )
    except Exception as error:
        raise ValueError(f"Chair can't do that yet: {error}") from error
    assert run.changeset is not None and run.verdict is not None
    ops = [item.model_dump(mode="json", by_alias=True) for item in run.changeset.items]
    if not ops:
        errors = [
            result.error
            for result in run.results
            if result.verdict == "rejected" and result.error
        ]
        detail = (
            errors[0]
            if errors
            else "; ".join(run.verdict.reasons) or "no section finished"
        )
        raise ValueError(f"Chair can't do that yet: {detail}")
    verdict = "accepted" if run.verdict.accepted else "rejected"
    listing = ", ".join(f"{task.section}:{task.id}" for task in run.tasks)
    return HandlerResult(
        artifacts=[],
        ops=ops,
        planner="crew",
        message=(
            f"crew {verdict}: {len(run.tasks)} tasks [{listing}], "
            f"{'; '.join(run.verdict.reasons) or 'all beats covered'}"
        ),
    )


def handle_edit(
    job: Job,
    *,
    client: ModelClient | None = None,
    silence: SilenceMeasurer | None = None,
    transcriber: TranscriptionAdapter | None = None,
    preview: PreviewRenderer | None = None,
) -> HandlerResult:
    """Job handler for the "edit" task: brief in, gated proposal out.

    A brief the cut/sound pipeline can't plan falls through to the crew
    instead of failing; a brief the crew also can't do fails plainly.
    Canned spans and preview URLs in the job input run as before; when
    they are absent, live dispatch runs the finding tools and renders
    the preview instead. The beat sheet, style profile, and frame/audio
    evidence ride along when the job input carries them. The turn's
    selected model and attachment names ride along too: validated here
    and kept on the job record, so the thread can prove which model a
    live turn ran with. (The v1 pipeline itself is rule-based and makes
    no model calls; a model-backed planner reads `input.model` as-is.)
    A rejected preview fails the job so the UI never shows it.
    """
    brief = job.input.get("brief", "")
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("job input needs a non-empty 'brief' string")
    if "model" in job.input:
        model = job.input["model"]
        if not isinstance(model, str) or not model.strip():
            raise ValueError("job input 'model' must be a non-empty string")
    if "files" in job.input:
        files = job.input["files"]
        if not isinstance(files, list) or not all(
            isinstance(name, str) and name.strip() for name in files
        ):
            raise ValueError("job input 'files' must be a list of file names")

    proxy_url = str(job.input.get("proxy_url") or "").strip()
    base_revision = str(job.input.get("base_revision") or "").strip()
    target_id = str(job.input.get("target_id") or "").strip()
    changeset_id = (
        str(job.input.get("changeset_id") or "").strip() or f"cs-{job.request_id}"
    )
    total_frames_raw = job.input.get("total_frames")
    total_frames = (
        int(total_frames_raw)
        if isinstance(total_frames_raw, (int, float)) and total_frames_raw > 0
        else 0
    )
    rate_raw = job.input.get("rate", 30.0)
    if not isinstance(rate_raw, (int, float)) or rate_raw <= 0:
        raise ValueError("job input 'rate' must be a number above 0")
    rate = float(rate_raw)

    if not proxy_url:
        from chair_agent.review import read_project_timeline

        proj_id = job.input.get("project_id")
        proj_ref = proj_id if isinstance(proj_id, str) and proj_id.strip() else None
        if not proj_ref and target_id:
            proj_ref = target_id
        timeline = read_project_timeline(proj_ref)
        clips = [
            clip
            for track in timeline.get("tracks", []) or []
            for clip in (track.get("clips", []) or [])
        ]
        if not clips:
            raise ValueError("Put a clip on the timeline first.")
        resolved_media, resolved_frames, resolved_target = _resolve_timeline_media(timeline)
        if not resolved_media:
            raise ValueError("Put a clip on the timeline first.")
        proxy_url = resolved_media
        if total_frames <= 0:
            total_frames = resolved_frames
        if not base_revision:
            base_revision = str(timeline.get("id") or "rev-0")
        if resolved_target:
            target_id = resolved_target

    context = LoopContext(
        proxy_url=proxy_url,
        base_revision=base_revision,
        target_id=target_id,
        changeset_id=changeset_id,
        total_frames=total_frames,
        rate=rate,
    )
    model_spec = job.input.get("model") if isinstance(job.input.get("model"), str) else None
    try:
        planned = plan_brief(brief, client=client, model=model_spec)
    except ValueError:
        planned = None
    if planned is None or not _has_dispatchable_intent(planned):
        return _handle_crew_brief(
            brief,
            client=client,
            model=model_spec,
            changeset_id=changeset_id,
            base_revision=base_revision or "rev-0",
            target_id=target_id or "timeline-1",
            total_frames=total_frames or 900,
        )
    dispatch_notes: list[str] = []
    if "spans" in job.input:
        spans = [Span.model_validate(item) for item in job.input.get("spans", [])]
    else:
        # Ducking inverts silence into dialogue regions, so it measures
        # silence too — but the cut filter keeps those spans out of the
        # blades unless the brief also asks for silence cuts.
        dispatch_intents = canonical_intents(list(planned.intents))
        if "duck_music_under_dialogue" in dispatch_intents and "silence" not in dispatch_intents:
            dispatch_intents.append("silence")
        used_silence = silence if silence is not None else build_sidecar_tools()
        used_transcriber = (
            transcriber if transcriber is not None else build_transcription_adapter()
        )
        spans, dispatch_notes = dispatch_spans_with_notes(
            dispatch_intents,
            context.proxy_url,
            silence=used_silence,
            transcriber=used_transcriber,
            rate=rate,
        )
    if "preview_urls" in job.input:
        artifact_urls = job.input.get("preview_urls", [])
        if not isinstance(artifact_urls, list) or not all(
            isinstance(url, str) for url in artifact_urls
        ):
            raise ValueError("job input 'preview_urls' must be a list of strings")
    else:
        used_preview = preview if preview is not None else build_sidecar_tools()
        artifact_urls = [used_preview.render_preview(context.proxy_url)]
    sfx, sfx_errors = _resolve_sfx_files(
        list(planned.intents),
        proxy_url=context.proxy_url,
        total_frames=context.total_frames,
        rate=rate,
        synth_url=sounds.sidecar_url(),
    )
    result = run_loop(
        brief,
        context,
        spans,
        artifact_urls=artifact_urls,
        plan=job.input.get("plan"),
        style=job.input.get("style"),
        frames=job.input.get("frames", []),
        audio=job.input.get("audio"),
        planned=planned,
        sfx=sfx,
        sfx_errors=sfx_errors,
    )
    if not result.verdict.accepted:
        reasons = list(result.verdict.reasons)
        if planned.message and planned.message not in reasons:
            reasons.append(planned.message)
        # A job that dispatches nothing fails loudly instead of reporting
        # "completed" with an empty proposal.
        raise PreviewRejected(reasons)
    skipped = [skip.model_dump(mode="json") for skip in result.skipped]
    message = planned.message
    if skipped and not message:
        message = "; ".join(f"{skip['intent']}: {skip['reason']}" for skip in skipped)
    if dispatch_notes:
        note = "; ".join(dispatch_notes)
        message = f"{message}; {note}" if message else note
    return HandlerResult(
        artifacts=[{"url": url} for url in artifact_urls],
        ops=result.changeset["items"],
        planner=planned.planner,
        message=message,
        skipped=skipped,
    )
