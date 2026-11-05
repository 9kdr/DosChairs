"""Crew image tests: fake adapter, tmp project dir, no keys, no network."""

import base64
import json
from pathlib import Path

import pytest
from chair_agent.assets import build_assets, projects_root
from chair_agent.client import Completion
from chair_agent.crew.command import Task, _command_messages
from chair_agent.crew.images import (
    expand_prompts,
    is_image_brief,
    match_cut_relevant,
    needs_images,
    shot_count,
    size_for,
    wants_timeline,
)
from chair_agent.crew.orchestrator import reset_status, run_crew, run_task
from chair_agent.images import GeneratedImage

PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA"
    "hKmMIQAAAABJRU5ErkJggg=="
)
PNG_BYTES = base64.b64decode(PNG_B64)


class FakeImageAdapter:
    """Records prompts and sizes; fails the prompts named in `fail`."""

    def __init__(self, *, fail: tuple[str, ...] = ()) -> None:
        self.prompts: list[str] = []
        self.sizes: list[str | None] = []
        self._fail = set(fail)

    def generate(self, prompt: str, *, size: str | None = None) -> GeneratedImage:
        self.prompts.append(prompt)
        self.sizes.append(size)
        if any(needle in prompt for needle in self._fail):
            raise RuntimeError("boom")
        return GeneratedImage(prompt=prompt, model="fake-image", b64_json=PNG_B64)


class FakeExpansionClient:
    """Answers prompt-expansion calls with canned text, and records them."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.seen: list[list] = []

    def execute(self, messages: list) -> Completion:
        self.seen.append(messages)
        return Completion(model="fake-spark", text=self.text)


def _projects(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    root = tmp_path / "projects"
    monkeypatch.setenv("CHAIR_PROJECTS_DIR", str(root))
    assert projects_root() == root.resolve()
    return root


def test_detection_routes_image_briefs() -> None:
    assert needs_images("make a 5-shot match cut: an eye, the moon")
    assert needs_images("generate key art for a rainy neon city")
    assert needs_images("three stills that feel lonely")
    assert needs_images("title card", ["skill: match-cut"])
    assert not needs_images("lower third with the name")
    assert not needs_images("kinetic titles timed to beats")
    assert wants_timeline("make a 5-shot match cut: an eye, the moon")
    assert wants_timeline("key art, then place it on the cut")
    assert not wants_timeline("generate key art for a rainy neon city")
    assert match_cut_relevant("make a 5-shot match cut")
    assert not match_cut_relevant("generate key art")


def test_shot_count_and_size() -> None:
    assert shot_count("make a 5-shot match cut") == 5
    assert shot_count("5 shots that feel lonely") == 5
    assert shot_count("three stills for the trailer") == 3
    assert shot_count("generate key art") == 1
    assert shot_count("make 40 stills") == 8  # capped
    assert size_for("make a 5-shot match cut") == "1792x1024"
    assert size_for("generate key art for a rainy neon city") == "1792x1024"
    assert size_for("square illustration stills") is None


def test_split_prompts_keep_the_shared_spec() -> None:
    prompts = expand_prompts(
        "make a 5-shot match cut: an eye, the moon, a coin, a tunnel, "
        "a sunflower, same circle centred",
        5, client=None,
    )
    assert len(prompts) == 5
    assert prompts[0].startswith("an eye")
    assert prompts[4].startswith("a sunflower")
    assert all("same circle centred" in prompt for prompt in prompts)


def test_single_goal_stays_verbatim() -> None:
    goal = "generate key art for a rainy neon city"
    assert expand_prompts(goal, 1, client=None) == [goal]


def test_expansion_uses_the_model_and_the_skill_when_relevant() -> None:
    client = FakeExpansionClient('["eye", "moon"]')
    prompts = expand_prompts("match cut: an eye, the moon", 2, client=client)
    assert prompts == ["eye", "moon"]
    developer = client.seen[0][0].content
    assert "anchor shape" in developer  # the match-cut skill rode along


def test_expansion_skips_the_skill_for_plain_briefs() -> None:
    client = FakeExpansionClient('{"prompts": ["rainy neon city"]} ')
    prompts = expand_prompts("generate key art for a rainy neon city", 1, client=client)
    assert prompts == ["rainy neon city"]
    assert "anchor shape" not in client.seen[0][0].content


def test_expansion_falls_back_on_garbage() -> None:
    client = FakeExpansionClient("{}")
    prompts = expand_prompts("match cut: an eye, the moon", 2, client=client)
    assert prompts == ["an eye", "the moon"]


def test_command_prompt_lists_the_skills() -> None:
    developer = _command_messages("a brief", [{"id": "b1", "label": "open"}])[0].content
    assert isinstance(developer, str)
    assert "match-cut:" in developer
    assert "skill: <id>" in developer
    assert "generated stills and key art" in developer


def test_match_cut_saves_stills_and_places_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _projects(monkeypatch, tmp_path)
    reset_status()
    adapter = FakeImageAdapter()
    task = Task(
        id="t1", beatId="b1", section="graphics",
        goal="make a 5-shot match cut: an eye, the moon, a coin, a tunnel, "
        "a sunflower, same circle centred",
    )
    result = run_task(
        task, "the sequence", image_adapter=adapter, project_id="proj-1"
    )
    assert result.verdict == "accepted"
    assert [item.op for item in result.items] == ["add_track"] + ["add_clip"] * 5
    assert result.items[0].patch["track"]["kind"] == "video"
    assert len(adapter.prompts) == 5
    assert set(adapter.sizes) == {"1792x1024"}
    for item in result.items[1:]:
        timeline = item.patch["clip"]["timelineRange"]
        assert timeline["duration"] == {"value": 12, "rate": 30.0}
    files = sorted((root / "proj-1" / "generated").glob("t1-*.png"))
    assert [path.name for path in files] == [f"t1-{n:02d}.png" for n in range(1, 6)]
    assert files[0].read_bytes() == PNG_BYTES
    sidecar = json.loads((root / "proj-1" / "generated" / "t1-01.json").read_text())
    assert sidecar["model"] == "fake-image"
    assert sidecar["prompt"].startswith("an eye")
    assert sidecar["created_at"]
    listing = build_assets("proj-1")
    kinds = [asset["kind"] for asset in listing["assets"]]
    assert kinds == ["image"] * 5
    assert listing["folders"][0]["id"] == "generated"
    assert len(result.artifacts) == 5
    assert all(url.startswith("file://") for url in result.artifacts)
    assert "new video track" in result.notes


def test_stills_start_on_beats_when_the_plan_has_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _projects(monkeypatch, tmp_path)
    reset_status()
    task = Task(
        id="t2", beatId="b1", section="graphics",
        goal="two stills on the timeline: a cat, a dog",
    )
    result = run_task(
        task, "the sequence", image_adapter=FakeImageAdapter(),
        project_id="proj-1", beat_times=(5.0, 9.0),
    )
    assert result.verdict == "accepted"
    starts = [
        item.patch["clip"]["timelineRange"]["start"]["value"]
        for item in result.items[1:]
    ]
    assert starts == [150, 270]


def test_key_art_stays_assets_without_timeline_items(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _projects(monkeypatch, tmp_path)
    reset_status()
    task = Task(
        id="t3", beatId="b1", section="graphics",
        goal="generate key art for a rainy neon city",
    )
    result = run_task(
        task, "the look", image_adapter=FakeImageAdapter(), project_id="proj-1"
    )
    assert result.verdict == "accepted"
    assert [item.op for item in result.items] == ["add_effect"]
    assert result.items[0].patch["assets"] == ["generated/t3-01.png"]
    assert (root / "proj-1" / "generated" / "t3-01.png").is_file()
    assert "media assets" in result.notes


def test_no_adapter_keeps_the_piece_placeholder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _projects(monkeypatch, tmp_path)
    reset_status()
    task = Task(
        id="t4", beatId="b1", section="graphics",
        goal="generate key art for a rainy neon city",
    )
    result = run_task(task, "the look")
    assert result.verdict == "accepted"
    assert [item.op for item in result.items] == ["add_effect"]
    assert "assets" not in result.items[0].patch


def test_failed_generation_rejects_instead_of_a_placeholder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _projects(monkeypatch, tmp_path)
    reset_status()
    task = Task(
        id="t5", beatId="b1", section="graphics",
        goal="generate key art for a rainy neon city",
    )
    adapter = FakeImageAdapter(fail=("rainy neon",))
    result = run_task(task, "the look", image_adapter=adapter, project_id="proj-1")
    assert result.verdict == "rejected"
    assert result.error and "image generation failed" in result.error


def test_partial_failure_keeps_what_succeeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _projects(monkeypatch, tmp_path)
    reset_status()
    task = Task(
        id="t6", beatId="b1", section="graphics",
        goal="two stills on the timeline: a cat, a dog",
    )
    result = run_task(
        task, "the sequence", image_adapter=FakeImageAdapter(fail=("a dog",)),
        project_id="proj-1",
    )
    assert result.verdict == "accepted"
    assert [item.op for item in result.items] == ["add_track", "add_clip"]
    assert "failures: shot 2" in result.notes


def test_crew_run_covers_a_match_cut_brief(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _projects(monkeypatch, tmp_path)
    reset_status()

    class CommandClient:
        def execute(self, messages: list) -> Completion:
            return Completion(model="fake-spark", text=(
                '{"tasks": [{"id": "t1", "beatId": "b1", "section": "graphics", '
                '"goal": "make a 2-shot match cut on the timeline: an eye, '
                'the moon, same circle centred"}]}'
            ))

        def complete_model(self, model: str, messages: list) -> Completion:
            return self.execute(messages)

    run = run_crew(
        "make a 2-shot match cut on the timeline",
        {"beats": [{"id": "b1", "intent": "the sequence"}]},
        client=CommandClient(),  # type: ignore[arg-type]
        image_adapter=FakeImageAdapter(), project_id="proj-1",
    )
    assert run.changeset is not None
    assert [item.op for item in run.changeset.items] == [
        "add_track", "add_clip", "add_clip",
    ]


def test_handle_edit_routes_an_image_brief_to_generated_stills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from chair_agent import jobs
    from chair_agent.crew import images as crew_images
    from chair_agent.loop import handle_edit

    root = _projects(monkeypatch, tmp_path)
    reset_status()
    adapter = FakeImageAdapter()
    monkeypatch.setattr(crew_images, "default_adapter", lambda: adapter)

    class RouteClient:
        def plan(self, messages):  # type: ignore[no-untyped-def]
            raise RuntimeError("planner unavailable")

        def execute(self, messages):  # type: ignore[no-untyped-def]
            return Completion(model="fake-spark", text=(
                '{"tasks": [{"id": "t1", "beatId": "b1", "section": "graphics", '
                '"goal": "generate key art for a rainy neon city"}]}'
            ))

        def complete_model(self, model, messages):  # type: ignore[no-untyped-def]
            return self.execute(messages)

    job = jobs.Job(
        request_id="job-1", task="edit",
        input={
            "brief": "generate key art for a rainy neon city",
            "proxy_url": "file:///proxy.mp4",
            "project_id": "proj-1",
        },
        created_at=datetime.now(UTC),
    )
    result = handle_edit(job, client=RouteClient())  # type: ignore[arg-type]
    assert result.planner == "crew"
    assert [op["op"] for op in result.ops] == ["add_effect"]
    assert result.ops[0]["patch"]["assets"] == ["generated/t1-01.png"]
    assert (root / "proj-1" / "generated" / "t1-01.png").is_file()


def test_is_image_brief_leaves_video_shots_to_the_planner() -> None:
    assert is_image_brief(
        "make a 5-shot match cut: an eye, the moon, same circle centred"
    )
    assert is_image_brief("generate key art for a rainy neon city")
    assert is_image_brief("5 shots that feel lonely")
    assert is_image_brief("three stills for the trailer")
    assert not is_image_brief("cut the silences in the wide shots")
    assert not is_image_brief("trim the opening shot")
    assert not is_image_brief("cut the silence")


def test_handle_edit_skips_planning_for_image_briefs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A live-style misplan (riser intent) must not steal an image brief."""
    from datetime import UTC, datetime

    from chair_agent import jobs
    from chair_agent.crew import images as crew_images
    from chair_agent.loop import handle_edit
    from chair_agent.planner import Plan, PlanStep

    _projects(monkeypatch, tmp_path)
    reset_status()
    monkeypatch.setattr(
        crew_images, "default_adapter", lambda: FakeImageAdapter()
    )
    calls: list[str] = []

    def misplan(brief: str, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(brief)
        return Plan(
            brief=brief, intents=["riser_into_cut"],
            steps=[PlanStep(tool="editor_op", goal="place a riser")],
            planner="model",
        )

    monkeypatch.setattr("chair_agent.loop.plan_brief", misplan)

    class RouteClient:
        def execute(self, messages):  # type: ignore[no-untyped-def]
            return Completion(model="fake-spark", text=(
                '{"tasks": [{"id": "t1", "beatId": "b1", "section": "graphics", '
                '"goal": "make a 2-shot match cut on the timeline: an eye, '
                'the moon, same circle centred"}]}'
            ))

        def complete_model(self, model, messages):  # type: ignore[no-untyped-def]
            return self.execute(messages)

    job = jobs.Job(
        request_id="job-img", task="edit",
        input={
            "brief": "make a 2-shot match cut on the timeline: an eye, "
            "the moon, same circle centred",
            "proxy_url": "file:///proxy.mp4",
            "project_id": "proj-1",
        },
        created_at=datetime.now(UTC),
    )
    result = handle_edit(job, client=RouteClient())  # type: ignore[arg-type]
    assert calls == []
    assert result.planner == "crew"
    assert [op["op"] for op in result.ops] == [
        "add_track", "add_clip", "add_clip",
    ]


def test_handle_edit_still_plans_video_shot_briefs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from chair_agent import jobs
    from chair_agent.loop import handle_edit

    _projects(monkeypatch, tmp_path)
    reset_status()
    calls: list[str] = []

    def fail_planning(brief: str, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(brief)
        raise ValueError("brief names nothing Chair plans yet")

    monkeypatch.setattr("chair_agent.loop.plan_brief", fail_planning)

    class RouteClient:
        def execute(self, messages):  # type: ignore[no-untyped-def]
            return Completion(model="fake-spark", text=(
                '{"tasks": [{"id": "t1", "beatId": "b1", "section": "graphics", '
                '"goal": "lower third with the name"}]}'
            ))

        def complete_model(self, model, messages):  # type: ignore[no-untyped-def]
            return self.execute(messages)

    job = jobs.Job(
        request_id="job-vid", task="edit",
        input={
            "brief": "cut the silences in the wide shots",
            "proxy_url": "file:///proxy.mp4",
        },
        created_at=datetime.now(UTC),
    )
    result = handle_edit(job, client=RouteClient())  # type: ignore[arg-type]
    assert calls == ["cut the silences in the wide shots"]
    assert result.planner == "crew"  # unplannable, so the crew takes it


def test_store_generated_never_overwrites(tmp_path: Path) -> None:
    from chair_agent.assets import store_generated

    first = store_generated(tmp_path, "still.png", b"one")
    second = store_generated(tmp_path, "still.png", b"two")
    assert first.name == "still.png"
    assert second.name == "still (2).png"
    assert first.read_bytes() == b"one"
    assert second.read_bytes() == b"two"
