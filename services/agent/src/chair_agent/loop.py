"""Plan, execute, verify: one brief in, one gated proposal out.

run_loop plans the brief, fills tool calls, builds the pending changeset,
and verifies the preview. show_to_ui is True only when the verifier
accepts; a rejection keeps the preview away from the UI.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict

from chair_agent.dispatch import (
    PreviewRenderer,
    SilenceMeasurer,
    build_sidecar_tools,
    dispatch_spans,
)
from chair_agent.executor import Span, ToolCall, cuts_to_changeset, fill_tool_calls
from chair_agent.jobs import HandlerResult, Job
from chair_agent.planner import Plan, plan_brief
from chair_agent.transcribe import TranscriptionAdapter, build_transcription_adapter
from chair_agent.verifier import Verdict, verify


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
) -> LoopResult:
    """Run plan, execute, verify for one brief against the proxy."""
    plan = plan_brief(brief)
    tool_calls = fill_tool_calls(plan, spans, proxy_url=context.proxy_url)
    changeset = cuts_to_changeset(
        spans,
        changeset_id=context.changeset_id,
        base_revision=context.base_revision,
        target_id=context.target_id,
        brief=brief,
    )
    dumped = changeset.model_dump(mode="json", by_alias=True, exclude_none=True)
    verdict = verify(dumped, artifact_urls=artifact_urls, total_frames=context.total_frames)
    return LoopResult(
        plan=plan,
        tool_calls=tool_calls,
        changeset=dumped,
        verdict=verdict,
        show_to_ui=verdict.accepted,
    )


def handle_edit(
    job: Job,
    *,
    silence: SilenceMeasurer | None = None,
    transcriber: TranscriptionAdapter | None = None,
    preview: PreviewRenderer | None = None,
) -> HandlerResult:
    """Job handler for the "edit" task: brief in, gated proposal out.

    Canned spans and preview URLs in the job input run as before; when
    they are absent, live dispatch runs the finding tools and renders
    the preview instead. A rejected preview fails the job so the UI
    never shows it.
    """
    brief = job.input.get("brief", "")
    if not isinstance(brief, str) or not brief.strip():
        raise ValueError("job input needs a non-empty 'brief' string")
    context = LoopContext.model_validate(
        {key: job.input.get(key) for key in
         ("proxy_url", "base_revision", "target_id", "changeset_id", "total_frames")}
    )
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
            plan_brief(brief).intents,
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
    result = run_loop(brief, context, spans, artifact_urls=artifact_urls)
    if not result.verdict.accepted:
        raise PreviewRejected(result.verdict.reasons)
    return HandlerResult(
        artifacts=[{"url": url} for url in artifact_urls],
        ops=result.changeset["items"],
    )
