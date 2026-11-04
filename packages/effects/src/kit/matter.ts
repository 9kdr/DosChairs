/**
 * matter.js seek adapter (MIT): `simulateWorld` re-simulates a world from
 * time 0 to `t` at a fixed step, so scrubbing to any frame in any order
 * paints the same frame. The world is rebuilt per call and never kept
 * between frames.
 *
 * A module builds matter bodies inside `build` (importing `matter-js`
 * itself), steps them with `Matter.Engine.update(engine, dt * 1000)` in
 * `step`, and reads positions in `snapshot`. Keep `dt` fixed and never read
 * a clock inside `build`/`step`.
 */
import { MAX_SIM_SEC, PHYSICS_DT } from "./physics.js";

/** A world that advances in fixed steps and can report its visible state. */
export interface SteppableWorld<S> {
  step(dt: number): void;
  snapshot(): S;
}

/** The matter-js module surface this file touches (`Common._seed` drives its internal randomness). */
export interface SeedableMatter {
  Common: { _seed: number };
}

/** Pin matter-js's internal randomness so re-simulation is bit-identical. Call once per render with a fixed seed. */
export function seedMatter(matter: SeedableMatter | null | undefined, seed: number): void {
  if (!matter || !matter.Common || !Number.isFinite(seed)) return;
  matter.Common._seed = seed | 0;
}

/** The state of `build()` advanced to exactly time `t` (clamped to [0, 120]s). */
export function simulateWorld<S>(build: () => SteppableWorld<S>, t: number, dt: number = PHYSICS_DT): S {
  const world = build();
  const step = dt > 0 && Number.isFinite(dt) ? dt : PHYSICS_DT;
  const end = Math.min(Math.max(0, t), MAX_SIM_SEC);
  const n = Math.floor(end / step + 1e-9);
  for (let i = 0; i < n; i++) world.step(step);
  const rest = end - n * step;
  if (rest > 1e-9) world.step(rest);
  return world.snapshot();
}
