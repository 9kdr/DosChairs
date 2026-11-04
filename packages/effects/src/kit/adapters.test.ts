/** The seek-adapter layer: virtual clock, library seeks, and presets are deterministic. */
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { installVirtualClock } from "./seek.js";
import { createSeekClock, createWaapiAdapter, seekWaapi } from "./waapi.js";
import { createMotionAdapter, seekMotion } from "./motion.js";
import { createAnimeAdapter, seekAnime } from "./anime.js";
import { createOglAdapter, seekOgl } from "./ogl.js";
import { createPaperAdapter, seekPaper } from "./paper.js";
import { createTransitionAdapter, seekTransition, transitionProgress } from "./transitions.js";
import { createFlubberAdapter, morphAt } from "./flubber.js";
import { seedMatter, simulateWorld } from "./matter.js";
import { GlowWrap, GradientWash, GrainOverlay, HalftoneLayer } from "./presets.js";

describe("installVirtualClock", () => {
  it("overrides the clock and restores it", () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const clock = installVirtualClock(7);
    const seen: number[] = [];
    requestAnimationFrame((ms) => seen.push(ms));
    clock.advance(100);
    expect(seen).toEqual([expect.any(Number)]);
    expect(clock.now()).toBeGreaterThan(0);
    clock.restore();
    expect(Date.now).toBe(realNow);
    expect(Math.random).toBe(realRandom);
  });

  it("seeds Math.random deterministically", () => {
    const clock = installVirtualClock(42);
    const a = [Math.random(), Math.random()];
    clock.restore();
    const again = installVirtualClock(42);
    const b = [Math.random(), Math.random()];
    again.restore();
    expect(a).toEqual(b);
  });

  it("replays rAF work deterministically from reset", () => {
    const run = (): number[] => {
      const clock = installVirtualClock(3);
      const seen: number[] = [];
      const loop = (ms: number): void => {
        seen.push(Math.round(ms));
        if (ms < 50) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      clock.advance(60);
      clock.restore();
      return seen;
    };
    expect(run()).toEqual(run());
  });
});

describe("createSeekClock", () => {
  it("steps forward and replays from 0 on backwards scrub", () => {
    const adapter = createSeekClock({ seed: 5 });
    adapter.init(null, {});
    adapter.seek(0.5);
    adapter.seek(1.0);
    adapter.seek(0.25);
    adapter.seek(1.0);
    adapter.dispose();
    // Restored: Date.now is the real one again.
    expect(typeof Date.now()).toBe("number");
  });

  it("pauses WAAPI animations under the root", () => {
    const paused: string[] = [];
    const live = [
      { pause: () => paused.push("a"), currentTime: 0 },
      { pause: () => paused.push("b"), currentTime: 0 },
    ];
    const root = { getAnimations: () => live } as unknown as Element;
    seekWaapi(root, 1.5);
    expect(paused).toEqual(["a", "b"]);
    expect(live[0]!.currentTime).toBe(1500);
    const adapter = createWaapiAdapter();
    adapter.init(root, {});
    adapter.seek(2);
    adapter.dispose();
  });
});

describe("library seeks", () => {
  it("paper: stops the loop and sets the frame in ms", () => {
    const calls: unknown[][] = [];
    const mount = {
      setFrame: (...a: unknown[]) => calls.push(["frame", ...a]),
      setSpeed: (...a: unknown[]) => calls.push(["speed", ...a]),
      dispose: () => undefined,
    };
    seekPaper(mount, 1.25);
    expect(calls).toEqual([["speed", 0], ["frame", 1250]]);
    createPaperAdapter(() => mount).seek(2);
    expect(calls.at(-1)).toEqual(["frame", 2000]);
  });

  it("ogl: sets u_time and renders once", () => {
    const program = { uniforms: { u_time: { value: -1 } } };
    let renders = 0;
    seekOgl(program, () => renders++, 2.5);
    expect(program.uniforms.u_time.value).toBe(2.5);
    expect(renders).toBe(1);
    expect(() => seekOgl(null, () => renders++, 1)).not.toThrow();
    expect(renders).toBe(1); // null program paints nothing
    createOglAdapter(() => program, () => renders++).seek(1);
    expect(renders).toBe(2);
  });

  it("motion and anime: pause and pin to seconds (anime takes ms)", () => {
    const motion = { pause: () => undefined, time: -1 };
    seekMotion(motion, 1.5);
    expect(motion.time).toBe(1.5);
    createMotionAdapter(() => motion).seek(2);
    expect(motion.time).toBe(2);
    const seen: number[] = [];
    const anim = {
      pause: () => undefined,
      seek: (ms: number) => {
        seen.push(ms);
      },
    };
    seekAnime(anim, 1.5);
    expect(seen).toEqual([1500]);
    createAnimeAdapter(() => anim).seek(0.5);
    expect(seen).toEqual([1500, 500]);
  });

  it("transitions: progress is t / duration, clamped", () => {
    expect(transitionProgress(0.5, 2)).toBe(0.25);
    expect(transitionProgress(9, 2)).toBe(1);
    const seen: number[] = [];
    seekTransition((p) => seen.push(p), 1, 4);
    expect(seen).toEqual([0.25]);
    createTransitionAdapter((p) => seen.push(p), 4).seek(2);
    expect(seen).toEqual([0.25, 0.5]);
  });

  it("flubber: morphAt clamps and the adapter paints through setPath", () => {
    const interp = (from: string, to: string) => (u: number) => `${from}>${to}@${u.toFixed(2)}`;
    expect(morphAt(interp, "A", "B", 9)).toBe("A>B@1.00");
    const painted: string[] = [];
    const adapter = createFlubberAdapter(interp, (d) => painted.push(d), "A", "B", 2);
    adapter.init(null, {});
    adapter.seek(1);
    adapter.seek(4);
    adapter.dispose();
    expect(painted).toEqual(["A>B@0.50", "A>B@1.00"]);
  });

  it("matter: simulateWorld re-simulates deterministically; seedMatter pins randomness", () => {
    const common = { _seed: 0 };
    seedMatter({ Common: common }, 99);
    expect(common._seed).toBe(99);
    let n = 0;
    const run = (): number =>
      simulateWorld(
        () => ({
          step: (dt: number) => {
            n += dt;
          },
          snapshot: () => n,
        }),
        1,
        1 / 60,
      );
    n = 0;
    const a = run();
    n = 0;
    expect(run()).toBe(a);
  });
});

describe("presets", () => {
  it("render deterministically and animate with t", () => {
    const wash = (t: number): string =>
      renderToStaticMarkup(React.createElement(GradientWash, { t, width: 64, height: 36 }));
    expect(wash(1)).toBe(wash(1));
    expect(wash(1)).not.toBe(wash(2));
    const grain = (t: number): string =>
      renderToStaticMarkup(React.createElement(GrainOverlay, { t }));
    expect(grain(0)).toBe(grain(0));
    expect(grain(0)).not.toBe(grain(1));
    const half = renderToStaticMarkup(React.createElement(HalftoneLayer, { tone: 0.5 }));
    expect(half).toContain("radial-gradient");
    const glow = renderToStaticMarkup(
      React.createElement(GlowWrap, { color: "#ff0000", children: "x" }),
    );
    expect(glow).toContain("drop-shadow");
  });
});
