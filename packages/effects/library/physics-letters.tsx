/**
 * Physics Letters (gold module): the word rains from above on a matter-js
 * rigid-body simulation, each letter released with an anime `stagger()` delay
 * and a touch of spin, landing on a baseline.
 *
 * Seeking: every render rebuilds the world, seeds `Common._seed`, and
 * re-simulates 0..t at a fixed 60 Hz step through `simulateWorld` — scrubbing
 * anywhere paints the same frame. Letters are plain spans translated from
 * the snapshot, so the whole animation lives in SSR markup.
 */
import React from "react";
import Matter from "matter-js";
import { stagger } from "animejs";
import type { EffectProps, PropSpec } from "@chair/effects";
import { clamp, num, seedMatter, simulateWorld } from "@chair/effects";

export const meta = {
  id: "physics-letters",
  name: "Physics Letters",
  kind: "generator",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  word: { type: "string", default: "CHAIR", title: "Word" },
  gravity: { type: "number", min: 0.2, max: 3, default: 1, title: "Gravity" },
  drop: { type: "number", min: 200, max: 1600, default: 1100, title: "Drop Height" },
  spin: { type: "number", min: -3, max: 3, default: 0.6, title: "Spin" },
  size: { type: "number", min: 40, max: 160, default: 96, title: "Letter Size" },
  accent: { type: "color", default: "#ff6a00", title: "Accent" },
  ink: { type: "color", default: "#101018", title: "Ink" },
  paper: { type: "color", default: "#f1ebdd", title: "Paper" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  word: string;
  gravity: number;
  drop: number;
  spin: number;
  size: number;
  accent: string;
  ink: string;
  paper: string;
}>;

interface Placed {
  x: number;
  y: number;
  angle: number;
}

const releaseAfter = stagger(90, { from: "first" });
const DUMMIES: Record<string, unknown>[] = [];

function layout(t: number, letters: string[], gravity: number, drop: number, spin: number, size: number, width: number, baseline: number): Placed[] {
  while (DUMMIES.length < letters.length) DUMMIES.push({});
  const cell = size * 0.72;
  const x0 = width / 2 - ((letters.length - 1) * cell) / 2;
  return simulateWorld(
    () => {
      seedMatter(Matter as unknown as { Common: { _seed: number } }, 7);
      const engine = Matter.Engine.create({ enableSleeping: false });
      engine.gravity.y = gravity;
      const ground = Matter.Bodies.rectangle(width / 2, baseline + size * 0.62, width * 2, size * 0.3, { isStatic: true, restitution: 0.2 });
      const bodies = letters.map((_, i) => {
        const delayMs = Number(releaseAfter(DUMMIES[i]!, i, DUMMIES)) || 0;
        const startY = -drop - (delayMs / 1000) * 900 - i * 4;
        const body = Matter.Bodies.rectangle(x0 + i * cell, startY, cell * 0.8, size, {
          restitution: 0.25,
          friction: 0.4,
        });
        Matter.Body.setAngularVelocity(body, spin * 0.06 * (i % 2 === 0 ? 1 : -1));
        return body;
      });
      Matter.Composite.add(engine.world, [ground, ...bodies]);
      return {
        step: (dt: number) => Matter.Engine.update(engine, dt * 1000),
        snapshot: (): Placed[] =>
          bodies.map((b) => ({ x: b.position.x, y: b.position.y, angle: b.angle })),
      };
    },
    t,
    1 / 60,
  );
}

export default function PhysicsLetters(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const word = c("word", "CHAIR").slice(0, 12) || "CHAIR";
  const letters = word.split("");
  const size = clamp(n("size", 96), 40, 160);
  const baseline = height * 0.62;
  const placed = layout(t, letters, n("gravity", 1), n("drop", 1100), n("spin", 0.6), size, width, baseline);
  const accent = c("accent", "#ff6a00");
  const ink = c("ink", "#101018");

  return (
    <div
      style={{ position: "absolute", inset: 0, background: c("paper", "#f1ebdd"), overflow: "hidden" }}
      data-word={word}
      data-frame={Math.round(t * 30)}
      data-y={placed.map((q) => q.y.toFixed(1)).join(",")}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: baseline + size * 0.47, height: 3, background: accent }} />
      {letters.map((ch, i) => {
        const q = placed[i] ?? { x: 0, y: 0, angle: 0 };
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              font: `700 ${size}px/1 sans-serif`,
              color: i === 0 ? accent : ink,
              transform: `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) translate(-50%, -50%) rotate(${(q.angle * 57.2958).toFixed(2)}deg)`,
            }}
          >
            {ch === " " ? " " : ch}
          </span>
        );
      })}
    </div>
  );
}
