import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@chair/timeline-ir";
import type { RunningTask } from "./RunningTasks";
import { suggestionsFor } from "./suggestions";

function task(overrides: Partial<RunningTask> = {}): RunningTask {
  return { id: "task-1", name: "Trim the intro", status: "Done", lane: "edit", ...overrides };
}

function makeClip(overrides: Partial<Clip> & { id: string; name: string }): Clip {
  const range = {
    start: { value: 0, rate: 30 },
    duration: { value: 90, rate: 30 },
  };
  return {
    sourceRange: range,
    timelineRange: range,
    ...overrides,
  };
}

function makeTimeline(tracks: Timeline["tracks"] = [], rate = { num: 30, den: 1 }): Timeline {
  return {
    schemaVersion: "0.1.0",
    id: "timeline-1",
    name: "Demo Cut",
    rate,
    tracks,
    markers: [],
  };
}

describe("suggestionsFor", () => {
  it("empty timeline gives []", () => {
    expect(suggestionsFor({ timeline: null, tasks: [] })).toEqual([]);
    expect(suggestionsFor({ timeline: makeTimeline([]), tasks: [] })).toEqual([]);
    expect(
      suggestionsFor({
        timeline: makeTimeline([
          { id: "v1", name: "V1", kind: "video", clips: [] },
          { id: "a1", name: "A1", kind: "audio", clips: [] },
        ]),
        tasks: [],
      }),
    ).toEqual([]);
  });

  it("clips but nothing qualifies gives [] (e.g. a single video clip with no audio and a title already present)", () => {
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Shot 01",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 }, // 10 seconds
            },
          }),
          makeClip({
            id: "title-1",
            name: "Intro Title",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
    ]);
    expect(suggestionsFor({ timeline, tasks: [] })).toEqual([]);
  });

  it("rule 1: a failed task leads to 'Retry <task name>'", () => {
    const failedTask = task({
      id: "task-err",
      name: "Balance shot 04",
      status: "Failed: refused by adapter",
    });
    const result = suggestionsFor({ timeline: null, tasks: [failedTask] });
    expect(result).toEqual([
      {
        kind: "retry",
        taskId: "task-err",
        label: "Retry Balance shot 04",
      },
    ]);

    // Also checks jobStatus === "failed"
    const failedJob = task({
      id: "task-job-fail",
      name: "Export XML",
      status: "error",
      jobStatus: "failed",
    });
    expect(suggestionsFor({ timeline: null, tasks: [failedJob] })[0]).toEqual({
      kind: "retry",
      taskId: "task-job-fail",
      label: "Retry Export XML",
    });
  });

  it("rule 2: music and dialogue both on the cut suggests ducking if not ducked yet", () => {
    const timeline = makeTimeline([
      {
        id: "a1",
        name: "Dialogue",
        kind: "audio",
        clips: [
          makeClip({
            id: "c-vo",
            name: "interview_take1.wav",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "a2",
        name: "Music Track",
        kind: "audio",
        clips: [
          makeClip({
            id: "c-bg",
            name: "background_score.mp3",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "v1",
        name: "Titles",
        kind: "subtitle",
        clips: [
          makeClip({
            id: "c-title",
            name: "Opening Title",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
    ]);

    const suggestions = suggestionsFor({ timeline, tasks: [] });
    expect(suggestions).toContainEqual({
      kind: "prompt",
      label: "Duck the music under the dialogue",
      text: "Duck the music under the dialogue",
    });

    // Does not offer if duck task already ran
    const duckedTasks = [task({ name: "Duck the music under the dialogue", status: "Done" })];
    expect(suggestionsFor({ timeline, tasks: duckedTasks })).toEqual([]);
  });

  it("rule 2: sees video clip with audio as dialogue alongside music", () => {
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "c-vid",
            name: "Camera A Roll.mov",
            metadata: { hasAudio: true },
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "a1",
        name: "Audio",
        kind: "audio",
        clips: [
          makeClip({
            id: "c-music",
            name: "upbeat_song.mp3",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "t1",
        name: "Titles",
        kind: "subtitle",
        clips: [
          makeClip({
            id: "c-title",
            name: "Main Title",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 60, rate: 30 },
            },
          }),
        ],
      },
    ]);

    const result = suggestionsFor({ timeline, tasks: [] });
    expect(result).toContainEqual({
      kind: "prompt",
      label: "Duck the music under the dialogue",
      text: "Duck the music under the dialogue",
    });
  });

  it("rule 3: dialogue present but no music clip suggests 'Add a music bed under the dialogue'", () => {
    const timeline = makeTimeline([
      {
        id: "a1",
        name: "A1",
        kind: "audio",
        clips: [
          makeClip({
            id: "c-voice",
            name: "voiceover.wav",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 300, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "v1",
        name: "Titles",
        kind: "subtitle",
        clips: [
          makeClip({
            id: "c-title",
            name: "Title Card",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 60, rate: 30 },
            },
          }),
        ],
      },
    ]);

    const suggestions = suggestionsFor({ timeline, tasks: [] });
    expect(suggestions).toEqual([
      {
        kind: "prompt",
        label: "Add a music bed under the dialogue",
        text: "Add a music bed under the dialogue",
      },
    ]);

    // Already covered by a music task
    const musicTasks = [task({ name: "Add a music bed under the dialogue", status: "Done" })];
    expect(suggestionsFor({ timeline, tasks: musicTasks })).toEqual([]);
  });

  it("rule 4: gaps of at least 0.5s suggest closing them", () => {
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Shot 01",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 }, // 0 to 3.0s
            },
          }),
          makeClip({
            id: "clip-2",
            name: "Shot 02",
            timelineRange: {
              start: { value: 120, rate: 30 }, // 4.0s (1.0s gap)
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "sub",
        name: "Subtitles",
        kind: "subtitle",
        clips: [
          makeClip({
            id: "c-sub",
            name: "Title 1",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 60, rate: 30 },
            },
          }),
        ],
      },
    ]);

    const suggestions = suggestionsFor({ timeline, tasks: [] });
    expect(suggestions).toEqual([
      {
        kind: "prompt",
        label: "Close the gaps on V1",
        text: "Close the gaps on V1",
      },
    ]);

    // Small gaps (< 0.5s) do not trigger
    const tightTimeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Shot 01",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 }, // 0 to 3.0s
            },
          }),
          makeClip({
            id: "clip-2",
            name: "Shot 02",
            timelineRange: {
              start: { value: 96, rate: 30 }, // 3.2s (0.2s gap < 0.5s)
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
      {
        id: "sub",
        name: "Subtitles",
        kind: "subtitle",
        clips: [
          makeClip({
            id: "c-sub",
            name: "Title 1",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 60, rate: 30 },
            },
          }),
        ],
      },
    ]);
    expect(suggestionsFor({ timeline: tightTimeline, tasks: [] })).toEqual([]);

    // Cut task already ran -> no gap chip
    const gapTasks = [task({ name: "Close the gaps on V1", status: "Done" })];
    expect(suggestionsFor({ timeline, tasks: gapTasks })).toEqual([]);
  });

  it("rule 5: clips on the cut but no title/effect suggests 'Add a title over the opening'", () => {
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Shot 01",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
    ]);

    const suggestions = suggestionsFor({ timeline, tasks: [] });
    expect(suggestions).toEqual([
      {
        kind: "prompt",
        label: "Add a title over the opening",
        text: "Add a title over the opening",
      },
    ]);

    // A title task already ran
    const titleTasks = [task({ name: "Add a title over the opening", status: "Done" })];
    expect(suggestionsFor({ timeline, tasks: titleTasks })).toEqual([]);

    // Or a clip already has effects
    const timelineWithEffect = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Shot 01",
            effects: [{ id: "eff-1", presetName: "Vignette", params: {} }],
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 },
            },
          }),
        ],
      },
    ]);
    expect(suggestionsFor({ timeline: timelineWithEffect, tasks: [] })).toEqual([]);
  });

  it("rule 6: a very long timeline (> 3 min) with one long clip suggests trimming silences", () => {
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          makeClip({
            id: "clip-1",
            name: "Raw Interview.mp4",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 6000, rate: 30 }, // 200 seconds (> 180s / 3m)
            },
          }),
        ],
      },
    ]);

    const suggestions = suggestionsFor({ timeline, tasks: [] });
    expect(suggestions[0]).toEqual({
      kind: "prompt",
      label: "Trim the silences in Raw Interview",
      text: "Trim the silences in Raw Interview.mp4",
    });

    // Silence task already ran
    const silenceTasks = [task({ name: "Trim the silences in Raw Interview", status: "Done" })];
    const afterTasks = suggestionsFor({ timeline, tasks: silenceTasks });
    expect(afterTasks.some((s) => s.label.startsWith("Trim the silences"))).toBe(false);
  });

  it("limits suggestions to at most 3 chips in most useful order", () => {
    const timeline = makeTimeline([
      {
        id: "a1",
        name: "A1",
        kind: "audio",
        clips: [
          makeClip({
            id: "c-vo",
            name: "interview_take1.wav",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 6000, rate: 30 }, // 200s
            },
          }),
        ],
      },
    ]);

    const tasks = [task({ id: "task-f", name: "Grade shot 01", status: "Failed: offline" })];

    const suggestions = suggestionsFor({ timeline, tasks });
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toEqual([
      { kind: "retry", taskId: "task-f", label: "Retry Grade shot 01" },
      {
        kind: "prompt",
        label: "Trim the silences in interview_take1",
        text: "Trim the silences in interview_take1.wav",
      },
      {
        kind: "prompt",
        label: "Add a music bed under the dialogue",
        text: "Add a music bed under the dialogue",
      },
    ]);
  });

  it("truncates chip labels to at most 40 characters", () => {
    const longName = "A Very Long Clip Name That Exceeds The Maximum Allowed Label Length By Far";
    const timeline = makeTimeline([
      {
        id: "v1",
        name: "A Very Long Track Name That Exceeds Forty Characters Easily",
        kind: "video",
        clips: [
          makeClip({
            id: "c1",
            name: longName,
            timelineRange: { start: { value: 0, rate: 30 }, duration: { value: 30, rate: 30 } },
          }),
          makeClip({
            id: "c2",
            name: "Shot 02",
            timelineRange: { start: { value: 90, rate: 30 }, duration: { value: 30, rate: 30 } },
          }),
        ],
      },
    ]);

    const tasks = [
      task({
        id: "t-long",
        name: "Do an extraordinary amount of processing on the long cut",
        status: "Failed: failed",
      }),
    ];

    const suggestions = suggestionsFor({ timeline, tasks });
    for (const item of suggestions) {
      expect(item.label.length).toBeLessThanOrEqual(40);
    }
  });
});
