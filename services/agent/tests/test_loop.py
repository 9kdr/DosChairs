import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from chair_agent.client import HttpxTransport, ModelClient, RoleModels
from chair_agent.executor import (
    SfxFile,
    Span,
    cuts_to_changeset,
    dialogue_regions,
    fill_tool_calls,
    merge_spans,
    sound_moment,
)
from chair_agent.jobs import HandlerResult, Job
from chair_agent.loop import LoopContext, PreviewRejected, handle_edit, run_loop
from chair_agent.planner import Plan, PlanStep, plan_brief, plan_with_model
from chair_agent.transcribe import Transcript, Word
from chair_agent.verifier import verify

GOLDEN = json.loads((Path(__file__).parent / "golden_run.json").read_text(encoding="utf-8"))


def _golden_input():
    data = GOLDEN["input"]
    return (
        data["brief"],
        LoopContext.model_validate(data["context"]),
        [Span.model_validate(item) for item in data["spans"]],
        data["artifact_urls"],
    )


def test_golden_run_replays() -> None:
    brief, context, spans, artifact_urls = _golden_input()
    result = run_loop(brief, context, spans, artifact_urls=artifact_urls)
    assert result.model_dump(mode="json") == GOLDEN["expected"]
    assert result.verdict.accepted and result.show_to_ui


def test_planner_orders_steps_per_intent() -> None:
    silence = plan_brief("cut the silence from the proxy")
    assert silence.intents == ["silence"]
    assert [step.tool for step in silence.steps] == [
        "measure_audio",
        "editor_op",
        "render_preview",
    ]
    filler = plan_brief("remove filler words")
    assert [step.tool for step in filler.steps] == [
        "transcribe",
        "editor_op",
        "render_preview",
    ]


def test_planner_rejects_empty_and_unknown_briefs() -> None:
    with pytest.raises(ValueError):
        plan_brief("   ")
    with pytest.raises(ValueError):
        plan_brief("make it pop with a grade")


def test_executor_merges_overlapping_spans() -> None:
    merged = merge_spans(
        [
            Span(start_frames=100, frames=50, kind="silence"),
            Span(start_frames=120, frames=50, kind="filler"),
            Span(start_frames=500, frames=10, kind="filler"),
        ]
    )
    assert [(span.start_frames, span.frames) for span in merged] == [(100, 70), (500, 10)]


def test_executor_calls_target_the_proxy() -> None:
    plan = plan_brief("remove silence and filler words")
    calls = fill_tool_calls(
        plan,
        [Span(start_frames=10, frames=5, kind="silence")],
        proxy_url="file:///proxy.mp4",
    )
    assert [call.tool for call in calls] == [step.tool for step in plan.steps]
    assert all(call.args["media_url"] == "file:///proxy.mp4" for call in calls)
    editor = next(call for call in calls if call.tool == "editor_op")
    assert editor.args["cuts"] == [{"start_frames": 10, "frames": 5, "kind": "silence"}]


def test_executor_rejects_unknown_tools() -> None:
    plan = Plan(
        brief="x",
        intents=[],
        steps=[PlanStep(tool="warp_drive", goal="go faster")],
    )
    with pytest.raises(ValueError):
        fill_tool_calls(plan, [], proxy_url="file:///proxy.mp4")


def test_verifier_rejects_before_the_ui() -> None:
    brief, context, spans, artifact_urls = _golden_input()
    golden = run_loop(brief, context, spans, artifact_urls=artifact_urls)
    changeset = golden.changeset
    assert verify(changeset, artifact_urls=[], total_frames=9000).accepted is False
    assert verify({}, artifact_urls=artifact_urls, total_frames=9000).accepted is False
    assert (
        verify({**changeset, "items": []}, artifact_urls=artifact_urls,
               total_frames=9000).accepted is False
    )
    bad_cut = dict(changeset["items"][0])
    bad_cut["patch"] = {"startFrames": 8990, "frames": 50}
    assert (
        verify({**changeset, "items": [bad_cut]}, artifact_urls=artifact_urls,
               total_frames=9000).accepted is False
    )


def test_loop_gates_the_ui_on_rejection() -> None:
    brief, context, spans, _ = _golden_input()
    result = run_loop(brief, context, spans, artifact_urls=[])
    assert result.verdict.accepted is False
    assert result.show_to_ui is False
    assert result.verdict.reasons


def _job(job_input: dict) -> Job:
    return Job(
        request_id="req_test",
        task="edit",
        input=job_input,
        created_at=datetime.now(UTC),
    )


def test_handler_returns_pending_ops_on_accept() -> None:
    data = GOLDEN["input"]
    job_input = {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
        "preview_urls": data["artifact_urls"],
    }
    result = handle_edit(_job(job_input))
    assert isinstance(result, HandlerResult)
    assert result.artifacts == [{"url": data["artifact_urls"][0]}]
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)


class _LiveSilence:
    def __init__(self) -> None:
        self.calls = 0

    def measure_silence(self, media_url: str) -> list[tuple[float, float]]:
        self.calls += 1
        assert media_url == "file:///proxies/interview-proxy.mp4"
        return [(4.0, 5.6)]


class _LiveTranscriber:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, audio_url: str, *, language: str | None = None) -> Transcript:
        self.calls += 1
        assert audio_url == "file:///proxies/interview-proxy.mp4"
        words = [
            Word(word="Welcome", start=1.0, end=1.5),
            Word(word="um", start=30.0, end=30.6),
        ]
        return Transcript(text="Welcome um", words=words)


class _LivePreview:
    def __init__(self) -> None:
        self.calls = 0

    def render_preview(self, media_url: str) -> str:
        self.calls += 1
        assert media_url == "file:///proxies/interview-proxy.mp4"
        return "file:///previews/live.mp4"


def test_handler_dispatches_live_runs_without_hand_fed_spans() -> None:
    data = GOLDEN["input"]
    job_input = {**data["context"], "brief": data["brief"]}
    silence, transcriber, preview = _LiveSilence(), _LiveTranscriber(), _LivePreview()
    result = handle_edit(
        _job(job_input), silence=silence, transcriber=transcriber, preview=preview
    )
    assert isinstance(result, HandlerResult)
    assert result.artifacts == [{"url": "file:///previews/live.mp4"}]
    assert [(op["patch"]["startFrames"], op["patch"]["frames"]) for op in result.ops] == [
        (120, 48),
        (900, 18),
    ]
    assert all(op["status"] == "pending" for op in result.ops)
    assert (silence.calls, transcriber.calls, preview.calls) == (1, 1, 1)


def test_handler_leaves_explicit_empties_canned() -> None:
    data = GOLDEN["input"]
    job_input = {**data["context"], "brief": data["brief"], "spans": [], "preview_urls": []}
    silence, transcriber, preview = _LiveSilence(), _LiveTranscriber(), _LivePreview()
    with pytest.raises(PreviewRejected):
        handle_edit(
            _job(job_input), silence=silence, transcriber=transcriber, preview=preview
        )
    assert (silence.calls, transcriber.calls, preview.calls) == (0, 0, 0)


def _content_input() -> dict:
    data = GOLDEN["input"]
    return {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
        "preview_urls": data["artifact_urls"],
        "plan": {
            "schemaVersion": "0.1.0",
            "id": "story_1",
            "brief": data["brief"],
            "status": "approved",
            "beats": [],
        },
        "style": {
            "schemaVersion": "0.1.0",
            "id": "style_1",
            "name": "house",
            "stats": {"targetLoudnessLufs": -16.0, "transitionVocabulary": ["cut"]},
            "presets": [],
            "exemplars": [
                {"id": f"ex_{index}", "summary": f"snippet {index}"} for index in range(3)
            ],
        },
    }


def test_handler_runs_the_content_gate_without_evidence() -> None:
    with pytest.raises(PreviewRejected) as rejected:
        handle_edit(_job(_content_input()))
    assert "no frame evidence for the preview" in rejected.value.reasons


def test_handler_completes_with_matching_evidence() -> None:
    job_input = {
        **_content_input(),
        "frames": [{"time_s": 5.0, "path": "/frames/f1.jpg", "caption": "room tone"}],
        "audio": {
            "path": "/audio/snippet.wav",
            "loudness_lufs": -16.5,
            "transcript": "welcome back",
        },
    }
    result = handle_edit(_job(job_input))
    assert isinstance(result, HandlerResult)
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)


def test_handler_rejects_and_validates_input() -> None:
    data = GOLDEN["input"]
    base = {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
    }
    with pytest.raises(PreviewRejected):
        handle_edit(_job({**base, "preview_urls": []}))
    with pytest.raises(ValueError):
        handle_edit(_job({**base, "preview_urls": data["artifact_urls"], "brief": "  "}))


def _canned_input() -> dict:
    data = GOLDEN["input"]
    return {
        **data["context"],
        "brief": data["brief"],
        "spans": data["spans"],
        "preview_urls": data["artifact_urls"],
    }


def test_handler_carries_the_turn_model_and_files() -> None:
    """The composer's pick and attachments ride on the job and still complete."""
    job_input = {
        **_canned_input(),
        "model": "muse-spark-1 (Meta)",
        "files": ["interview-proxy.mp4", "voice-note-120301.webm"],
    }
    result = handle_edit(_job(job_input))
    assert isinstance(result, HandlerResult)
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)


def test_handler_accepts_a_chair_preset_model() -> None:
    result = handle_edit(_job({**_canned_input(), "model": "Chair fast"}))
    assert isinstance(result, HandlerResult)
    assert result.ops


@pytest.mark.parametrize("model", ["", "   ", None, 123, ["Chair"]])
def test_handler_rejects_a_bad_model(model: object) -> None:
    with pytest.raises(ValueError, match="model"):
        handle_edit(_job({**_canned_input(), "model": model}))


@pytest.mark.parametrize(
    "files", ["interview.mp4", [123], [""], ["  "], [{"name": "a.mp4"}]]
)
def test_handler_rejects_bad_files(files: object) -> None:
    with pytest.raises(ValueError, match="files"):
        handle_edit(_job({**_canned_input(), "files": files}))


def _fake_client(reply_content: str, *, status_code: int = 200) -> ModelClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if status_code != 200:
            return httpx.Response(status_code, json={"error": "mock error"})
        return httpx.Response(200, json={"choices": [{"message": {"content": reply_content}}]})

    return ModelClient(
        models=RoleModels(planner="muse-wonder-1.0", executor=None, verifier=None),
        transport=HttpxTransport(
            "https://example.test/v1",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        ),
        api_key="test-key",
    )


def test_plan_with_model_validates_and_parses() -> None:
    reply = (
        "```json\n"
        "{\n"
        '  "intents": ["silence"],\n'
        '  "steps": [\n'
        '    {"tool": "measure_audio", "goal": "find quiet spots"},\n'
        '    {"tool": "editor_op", "goal": "cut quiet spots"},\n'
        '    {"tool": "render_preview", "goal": "make preview"}\n'
        "  ]\n"
        "}\n"
        "```"
    )
    client = _fake_client(reply)
    plan = plan_with_model("Cut out the pauses", client)
    assert plan.brief == "Cut out the pauses"
    assert plan.intents == ["silence"]
    assert [s.tool for s in plan.steps] == ["measure_audio", "editor_op", "render_preview"]
    assert plan.planner == "model"
    assert plan.message is None


def test_plan_with_model_rejects_unknown_tools() -> None:
    reply = json.dumps({
        "intents": ["speed"],
        "steps": [{"tool": "warp_speed", "goal": "go fast"}],
    })
    client = _fake_client(reply)
    with pytest.raises(ValueError, match="unknown tool"):
        plan_with_model("Speed it up", client)


def test_plan_with_model_handles_undispatched_intents() -> None:
    reply = json.dumps({
        "intents": ["silence", "grade"],
        "steps": [
            {"tool": "measure_audio", "goal": "find silence"},
            {"tool": "grade", "goal": "warm grade"},
            {"tool": "editor_op", "goal": "cut silence"},
            {"tool": "render_preview", "goal": "preview"},
        ],
    })
    client = _fake_client(reply)
    plan = plan_with_model("Cut silence and make it warmer", client)
    assert plan.intents == ["silence", "grade"]
    assert plan.message == "Cannot dispatch intents yet: grade"
    assert plan.planner == "model"


def test_plan_brief_falls_back_to_rules_on_model_error() -> None:
    client = _fake_client("internal server error", status_code=500)
    plan = plan_brief("cut the silence from the proxy", client=client)
    assert plan.planner == "rules"
    assert plan.intents == ["silence"]


def test_plan_brief_falls_back_to_rules_on_invalid_answer() -> None:
    reply = json.dumps({
        "intents": ["silence"],
        "steps": [{"tool": "unregistered_cutter", "goal": "cut"}],
    })
    client = _fake_client(reply)
    plan = plan_brief("remove filler words", client=client)
    assert plan.planner == "rules"
    assert plan.intents == ["filler"]


def test_plan_brief_raises_when_fallback_rules_cannot_plan() -> None:
    client = _fake_client("crash", status_code=500)
    with pytest.raises(ValueError, match="nothing Chair plans yet"):
        plan_brief("make the look warmer with a grade", client=client)


def test_plan_brief_without_key_uses_rules() -> None:
    plan = plan_brief("cut the silence", env={})
    assert plan.planner == "rules"
    assert plan.intents == ["silence"]


def test_handle_edit_records_planner_and_undispatched_message() -> None:
    reply = json.dumps({
        "intents": ["silence", "grade"],
        "steps": [
            {"tool": "measure_audio", "goal": "find quiet spans"},
            {"tool": "grade", "goal": "color grade"},
            {"tool": "editor_op", "goal": "cut silence"},
            {"tool": "render_preview", "goal": "render preview"},
        ],
    })
    client = _fake_client(reply)
    data = GOLDEN["input"]
    job_input = {**data["context"], "brief": "Cut silence and add a warm grade"}
    silence, transcriber, preview = _LiveSilence(), _LiveTranscriber(), _LivePreview()
    job = _job(job_input)
    before = json.loads(json.dumps(job.input))
    result = handle_edit(
        job, client=client, silence=silence, transcriber=transcriber, preview=preview
    )

    # The input stays as submitted, so an idempotent resubmit still matches.
    assert job.input == before
    assert result.planner == "model"
    assert result.message == "Cannot dispatch intents yet: grade"
    assert isinstance(result, HandlerResult)
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)
    # The dropped intent is reported, not silently filtered.
    assert result.skipped == [
        {"intent": "grade", "reason": "Chair cannot dispatch grade yet"}
    ]


def test_handle_edit_undispatched_only_fails_loudly() -> None:
    reply = json.dumps({
        "intents": ["grade"],
        "steps": [{"tool": "grade", "goal": "warm tone"}],
    })
    client = _fake_client(reply)
    data = GOLDEN["input"]
    job_input = {**data["context"], "brief": "Make the clip warmer with a grade"}
    silence, transcriber, preview = _LiveSilence(), _LiveTranscriber(), _LivePreview()
    job = _job(job_input)
    # A job that dispatches nothing fails instead of reporting "completed".
    with pytest.raises(PreviewRejected) as rejected:
        handle_edit(
            job, client=client, silence=silence, transcriber=transcriber, preview=preview
        )
    assert "Cannot dispatch intents yet: grade" in str(rejected.value)


def test_handler_resolves_proxy_from_project_timeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timeline = {
        "schemaVersion": "0.1.0",
        "id": "demo-timeline-1",
        "name": "Demo",
        "rate": {"num": 30, "den": 1},
        "tracks": [
            {
                "id": "v1",
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "id": "c1",
                        "name": "Clip",
                        "mediaRef": "file:///proxies/interview-proxy.mp4",
                        "timelineRange": {
                            "start": {"value": 0, "rate": 30},
                            "duration": {"value": 1500, "rate": 30},
                        },
                        "sourceRange": {
                            "start": {"value": 0, "rate": 30},
                            "duration": {"value": 1500, "rate": 30},
                        },
                    }
                ],
            }
        ],
        "markers": [],
    }
    monkeypatch.setattr(
        "chair_agent.review.read_project_timeline", lambda ref: timeline
    )
    submitted = {"brief": "cut the silence", "project_id": "kdenlive:demo-cut"}
    job = _job(dict(submitted))
    silence, transcriber, preview = _LiveSilence(), _LiveTranscriber(), _LivePreview()
    result = handle_edit(
        job, silence=silence, transcriber=transcriber, preview=preview
    )
    assert isinstance(result, HandlerResult)
    # Input stays as submitted so an idempotent resubmit still matches.
    assert job.input == submitted
    assert {op["targetId"] for op in result.ops} == {"demo-timeline-1"}
    assert result.ops
    assert all(op["status"] == "pending" for op in result.ops)
    assert (silence.calls, transcriber.calls, preview.calls) == (1, 0, 1)


def test_handle_edit_model_pick_drives_planner(monkeypatch: pytest.MonkeyPatch) -> None:
    from chair_agent.client import _MEMORY_KEYS, HttpxTransport, set_key

    _MEMORY_KEYS.clear()
    reply = json.dumps({
        "intents": ["silence"],
        "steps": [
            {"tool": "measure_audio", "goal": "find quiet spans"},
            {"tool": "editor_op", "goal": "cut silence"},
            {"tool": "render_preview", "goal": "render preview"},
        ],
    })

    called_url = []

    def handler(request: httpx.Request) -> httpx.Response:
        called_url.append(str(request.url))
        payload = json.loads(request.content)
        assert payload["model"] == "gpt-4o"
        return httpx.Response(200, json={"choices": [{"message": {"content": reply}}]})

    mock_client = httpx.Client(transport=httpx.MockTransport(handler))
    def _mock_init(self, base_url, **kwargs):
        self.base_url = base_url
        self._client = mock_client

    monkeypatch.setattr(HttpxTransport, "__init__", _mock_init)

    set_key("openai", "test-key-openai")
    data = GOLDEN["input"]
    job_input = {
        **data["context"],
        "brief": "Cut the pauses",
        "model": "gpt-4o (OpenAI)",
        "spans": data["spans"],
        "preview_urls": data["artifact_urls"],
    }
    before = dict(job_input)
    job = _job(job_input)
    result = handle_edit(job)

    # Verify input not modified
    assert job.input == before
    # Verify planner was model
    assert result.planner == "model"
    assert any("api.openai.com" in url for url in called_url)
    _MEMORY_KEYS.clear()




def _sound_plan() -> Plan:
    brief = "riser into the cut at 00:00:05, tape stop at the end, duck music under dialogue"
    return Plan(
        brief=brief,
        intents=["riser_into_cut", "tape_stop_outro", "duck_music_under_dialogue"],
        steps=[
            PlanStep(tool="measure_audio", goal="find silent spans on the proxy"),
            PlanStep(tool="transcribe", goal="find filler words on the proxy"),
            PlanStep(tool="editor_op", goal="place SFX and ducking on a new audio track"),
            PlanStep(tool="render_preview", goal="render a low-res preview"),
        ],
    )


def _sound_sfx() -> dict:
    return {
        "riser": SfxFile(
            kind="riser", path="/sfx/riser.wav", name="riser.wav",
            duration_seconds=2.0, source="synth", license="generated",
        ),
        "tape-stop": SfxFile(
            kind="tape-stop", path="/sfx/tape-stop.wav", name="tape-stop.wav",
            duration_seconds=1.2, source="synth", license="generated",
        ),
    }


def test_rules_plan_covers_the_sound_brief() -> None:
    plan = plan_brief(
        "riser into the cut at 00:00:05, tape stop at the end, duck music under dialogue",
        env={},
    )
    assert plan.planner == "rules"
    assert plan.intents == [
        "riser_into_cut", "tape_stop_outro", "duck_music_under_dialogue",
    ]
    assert [step.tool for step in plan.steps] == [
        "measure_audio", "transcribe", "editor_op", "render_preview",
    ]


def test_sound_moment_reads_timecodes() -> None:
    assert sound_moment("riser into the cut at 00:00:05") == 5.0
    assert sound_moment("hit it at 1:05") == 65.0
    assert sound_moment("duck under dialogue") is None


def test_dialogue_regions_invert_silence() -> None:
    spans = [Span(start_frames=60, frames=60, kind="silence")]
    assert dialogue_regions(spans, 600) == [(0, 60), (120, 600)]
    assert dialogue_regions(spans, 0) == []


def test_cuts_leave_duck_silence_out_of_the_blades() -> None:
    spans = [Span(start_frames=60, frames=60, kind="silence")]
    duck_only = cuts_to_changeset(
        spans, changeset_id="cs", base_revision="r", target_id="t", brief="b",
        intents=["duck_music_under_dialogue"],
    )
    assert duck_only.items == []
    silence = cuts_to_changeset(
        spans, changeset_id="cs", base_revision="r", target_id="t", brief="b",
        intents=["silence"],
    )
    assert len(silence.items) == 1


def test_run_loop_places_riser_duck_and_tape_stop() -> None:
    planned = _sound_plan()
    context = LoopContext(
        proxy_url="file:///proxy.mp4", base_revision="rev-0",
        target_id="music-1", changeset_id="cs-sound-1",
        total_frames=600, rate=30.0,
    )
    spans = [Span(start_frames=60, frames=60, kind="silence")]
    result = run_loop(
        planned.brief, context, spans,
        artifact_urls=["file:///previews/sound.mp4"],
        planned=planned, sfx=_sound_sfx(),
    )
    assert result.verdict.accepted and result.show_to_ui
    assert result.skipped == []
    ops = result.changeset["items"]
    assert [op["op"] for op in ops] == ["add_track", "add_clip", "add_clip", "set_gain"]
    riser = next(op for op in ops if op["id"] == "sfx-riser-1")
    # The riser ends exactly on the 5s cut: 3s start, 2s long at 30fps.
    assert riser["patch"]["clip"]["timelineRange"]["start"] == {"value": 90, "rate": 30.0}
    assert riser["patch"]["clip"]["timelineRange"]["duration"] == {"value": 60, "rate": 30.0}
    tape = next(op for op in ops if op["id"] == "sfx-tape-stop-1")
    assert tape["patch"]["clip"]["timelineRange"]["start"] == {"value": 600, "rate": 30.0}
    duck = next(op for op in ops if op["op"] == "set_gain")
    keyframes = duck["patch"]["keyframes"]
    assert len(keyframes) == 8
    assert keyframes[1] == {"timeSeconds": 0.0, "gainDb": -12.0}
    assert keyframes[2] == {"timeSeconds": 2.0, "gainDb": -12.0}
    assert keyframes[5] == {"timeSeconds": 4.0, "gainDb": -12.0}
    assert all(op["status"] == "pending" for op in ops)


def test_run_loop_reports_missing_sfx_as_skipped() -> None:
    planned = _sound_plan()
    context = LoopContext(
        proxy_url="file:///proxy.mp4", base_revision="rev-0",
        target_id="music-1", changeset_id="cs-sound-2",
        total_frames=600, rate=30.0,
    )
    spans = [Span(start_frames=60, frames=60, kind="silence")]
    result = run_loop(
        planned.brief, context, spans,
        artifact_urls=["file:///previews/sound.mp4"],
        planned=planned, sfx={},
    )
    # Ducking still dispatches, so the job completes with the gaps named.
    assert result.verdict.accepted
    assert [op["op"] for op in result.changeset["items"]] == ["set_gain"]
    assert [skip.intent for skip in result.skipped] == [
        "riser_into_cut", "tape_stop_outro",
    ]
    assert all(skip.reason for skip in result.skipped)


def test_run_loop_skips_riser_without_a_cut_time() -> None:
    planned = Plan(
        brief="add a riser and duck the music",
        intents=["riser_into_cut", "duck_music_under_dialogue"],
        steps=[PlanStep(tool="editor_op", goal="place sounds")],
    )
    context = LoopContext(
        proxy_url="file:///proxy.mp4", base_revision="rev-0",
        target_id="music-1", changeset_id="cs-sound-3",
        total_frames=600, rate=30.0,
    )
    result = run_loop(
        planned.brief, context, [Span(start_frames=0, frames=30, kind="silence")],
        artifact_urls=["file:///previews/sound.mp4"],
        planned=planned, sfx=_sound_sfx(),
    )
    assert result.verdict.accepted
    assert [skip.intent for skip in result.skipped] == ["riser_into_cut"]
    assert "cut time" in result.skipped[0].reason


def test_handle_edit_says_so_on_an_empty_timeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "chair_agent.review.read_project_timeline",
        lambda ref: {"id": "empty", "tracks": [], "markers": []},
    )
    with pytest.raises(ValueError, match="Put a clip on the timeline first"):
        handle_edit(_job({"brief": "duck music under dialogue", "project_id": "x"}))
