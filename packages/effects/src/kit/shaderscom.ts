/**
 * shaders.com (MIT) seek adapter: WebGPU components from the `shaders`
 * package, driven frame-locked so every seek paints the same frame.
 *
 * Rule, measured in headless chromium (see #304): a fresh preset renderer
 * plus `renderFrame({ deltaSeconds: t })` plus one `{ deltaSeconds: 0 }`
 * repaint paints byte-identical frames for the same t in any order. The
 * repaint matters: the first frame after init is unsettled (extra zero
 * frames change nothing after it), and splitting t across calls without the
 * repaint gives a different frame. So a seek always rebuilds the renderer
 * and paints exactly [t, 0]; prop changes rebuild too, since they arrive as
 * a new preset.
 *
 * Structural typing on purpose: the kit never imports `shaders/core`
 * itself (that 6 MB bundle stays out of every module that does not use
 * it). The module passes `createRendererFromJSON` as the factory.
 */
import type { PresetConfig } from "shaders/core";
import type { SeekAdapter } from "./seek.js";

/** The only shaders/core surface the adapter touches. */
export interface ShadersComRenderer {
  initialize(canvas: HTMLCanvasElement): Promise<unknown>;
  renderFrame(options?: { deltaSeconds?: number; waitForGpu?: boolean }): Promise<unknown>;
  getFailureReason(): string | null;
  dispose(): void;
}

/** A seek target: the canvas to paint, the preset to paint, the factory. */
export interface ShadersComTarget {
  canvas: HTMLCanvasElement;
  /** Components for this seek; sample keyframed props at t before building. */
  buildPreset: () => PresetConfig;
  /** Usually `(preset) => createRendererFromJSON(preset)`. */
  createRenderer: (preset: PresetConfig) => ShadersComRenderer;
}

/**
 * Paint time t on a live renderer: advance by exactly t, then repaint
 * without advancing so the settled frame (not the first-frame transient)
 * is what the host captures. Await it; back-to-back calls queue in order.
 */
export async function seekShadersComRenderer(renderer: ShadersComRenderer, t: number): Promise<void> {
  await renderer.renderFrame({ deltaSeconds: Math.max(0, t) });
  await renderer.renderFrame({ deltaSeconds: 0 });
}

function mark(canvas: HTMLCanvasElement, status: string): void {
  try {
    canvas.dataset["shadersStatus"] = status;
  } catch {
    /* a host without dataset still shows the painted frame */
  }
}

/**
 * A SeekAdapter over one shaders.com canvas. `seek(t)` rebuilds the
 * renderer from `buildPreset()` and paints [t, 0]; overlapping seeks
 * coalesce so the last one wins. Safe no-op when the target is null
 * (server rendering) or WebGPU is missing (marks data-shaders-status).
 */
export function createShadersComAdapter(getTarget: () => ShadersComTarget | null): SeekAdapter {
  let queued: { target: ShadersComTarget; t: number } | null = null;
  let running = false;
  let renderer: ShadersComRenderer | null = null;
  let gen = 0;

  const paint = async (target: ShadersComTarget, t: number, g: number): Promise<void> => {
    const stale = (): boolean => g !== gen;
    const drop = (r: ShadersComRenderer | null): void => {
      if (!r) return;
      try {
        r.dispose();
      } catch {
        /* already gone */
      }
    };
    drop(renderer);
    renderer = null;
    let fresh: ShadersComRenderer | null = null;
    try {
      fresh = target.createRenderer(target.buildPreset());
      await fresh.initialize(target.canvas);
      if (stale()) {
        drop(fresh);
        return;
      }
      if (fresh.getFailureReason()) {
        mark(target.canvas, "unavailable");
        return;
      }
      renderer = fresh;
      await seekShadersComRenderer(fresh, t);
      if (stale()) {
        if (renderer === fresh) renderer = null;
        drop(fresh);
        return;
      }
      mark(target.canvas, "ready");
    } catch {
      if (!stale()) mark(target.canvas, "unavailable");
    } finally {
      if (fresh && renderer !== fresh) drop(fresh);
    }
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queued) {
        const next = queued;
        queued = null;
        await paint(next.target, next.t, gen);
      }
    } finally {
      running = false;
    }
  };

  return {
    init() {},
    seek(t: number) {
      const target = getTarget();
      if (!target) return;
      // Synchronous mark so a host harness can wait for the async paint.
      mark(target.canvas, "pending");
      queued = { target, t };
      void run();
    },
    dispose() {
      gen += 1;
      queued = null;
      try {
        renderer?.dispose();
      } catch {
        /* already gone */
      }
      renderer = null;
    },
  };
}
