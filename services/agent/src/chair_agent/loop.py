"""Plan, execute, verify: one brief in, one gated proposal out.

run_loop plans the brief, fills tool calls, builds the pending changeset,
and verifies the preview. show_to_ui is True only when the verifier
accepts; a rejection keeps the preview away from the UI.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from chair_agent.beats import StoryPlan
from chair_agent.client import ModelClient
from chair_agent.dispatch import (
    PreviewRenderer,
    SilenceMeasurer,
    build_sidecar_tools,
    dispatch_spans,
)
from chair_agent.executor import Span, ToolCall, cuts_to_changeset, fill_tool_calls
from chair_agent.jobs import HandlerResult, Job
from chair_agent.planner import Plan, plan_brief
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


class LoopResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    plan: Plan
    tool_calls: list[ToolCall]
    changeset: dict[str, Any]
    verdict: Verdict
    show_to_ui: bool
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
) -> LoopResult:
    """Run plan, execute, verify for one brief against the proxy.

    The beat sheet, style profile, and frame/audio evidence are
    optional: absent, the mechanical verdict stands alone as before.
    """
    planned = plan_brief(brief, client=client)
    executable_plan = Plan(
        brief=planned.brief,
        intents=[i for i in planned.intents if i in ("silence", "filler")],
        steps=[s for s in planned.steps if s.tool in _EXECUTOR_TOOLS],
    )
    tool_calls = fill_tool_calls(executable_plan, spans, proxy_url=context.proxy_url)
    changeset = cuts_to_changeset(
        spans,
        changeset_id=context.changeset_id,
        base_revision=context.base_revision,
        target_id=context.target_id,
        brief=brief,
    )
    dumped = changeset.model_dump(mode="json", by_alias=True, exclude_none=True)
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
        message=planned.message,
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
    context = LoopContext.model_validate(
        {key: job.input.get(key) for key in
         ("proxy_url", "base_revision", "target_id", "changeset_id", "total_frames")}
    )
    planned = plan_brief(brief, client=client)
    job.input["planner"] = planned.planner
    if planned.message:
        job.input["message"] = planned.message
        job.input["reply"] = planned.message

    if "spans" in job.input:
        spans = [Span.model_validate(item) for item in job.input.get("spans", [])]
    else:
        rate = job.input.get("rate", 30.0)
        if not isinstance(rate, (int, float)) or rate <= 0:
            raise ValueError("job input 'rate' must be a number above 0")
        used_silence = silence if silence is not None else build_sidecar_tools()
        used_transcriber = (
            transcriber if transcriber is not None else build_transcription_adapter()
        )
        spans = dispatch_spans(
            planned.intents,
            context.proxy_url,
            silence=used_silence,
            transcriber=used_transcriber,
            rate=float(rate),
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
    result = run_loop(
        brief,
        context,
        spans,
        artifact_urls=artifact_urls,
        plan=job.input.get("plan"),
        style=job.input.get("style"),
        frames=job.input.get("frames", []),
        audio=job.input.get("audio"),
        client=client,
    )
    if not result.verdict.accepted:
        if not spans and planned.message:
            return HandlerResult(
                artifacts=[{"url": url} for url in artifact_urls],
                ops=[],
            )
        raise PreviewRejected(result.verdict.reasons)
    return HandlerResult(
        artifacts=[{"url": url} for url in artifact_urls],
        ops=result.changeset["items"],
    )
