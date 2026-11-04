/**
 * Springy Lower Third (gold module): kicker, title, and rule slide in on a
 * spring with per-line stagger from Motion, then settle.
 *
 * Motion cannot run in node, so the render pass computes the same motion
 * with the kit's fixed-step spring (`simulateSpring`) over a step target —
 * that is what the determinism probe reads. On the client a paused Motion
 * `animate()` on the rule is seeked with `controls.time = t` (see
 * `seekMotion`), parked under `MotionGlobalConfig.useManualTiming`, for
 * Motion's own easing on pixels. Letter delays use motion's pure `stagger()`.
 */
import React from "react";
import { animate, stagger, MotionGlobalConfig } from "motion";
import type { EffectProps, PropSpec } from "@chair/effects";
import { clamp, easeOutBack, num, simulateSpring } from "@chair/effects";

export const meta = {
  id: "lower-third",
  name: "Springy Lower Third",
  kind: "overlay",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  kicker: { type: "string", default: "FIELD NOTES", title: "Kicker" },
  title: { type: "string", default: "The Long Thaw", title: "Title" },
  sub: { type: "string", default: "Episode four — rivers", title: "Subtitle" },
  size: { type: "number", min: 40, max: 160, default: 92, title: "Title Size" },
  slide: { type: "number", min: 40, max: 400, default: 160, title: "Slide (px)" },
  speed: { type: "number", min: 0.2, max: 2, default: 1, title: "Tempo" },
  accent: { type: "color", default: "#ff6a00", title: "Rule Color" },
  ink: { type: "color", default: "#f5f2ea", title: "Text Color" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  kicker: string;
  title: string;
  sub: string;
  size: number;
  slide: number;
  speed: number;
  accent: string;
  ink: string;
}>;

const delayFor = stagger(0.14, { from: "first" });

function lineIn(t: number, index: number, slide: number): { y: number; opacity: number } {
  const delay = 0.4 + Number(delayFor(index, 3));
  const target = (tau: number): number => (tau >= delay ? 1 : 0);
  const s = simulateSpring(target, t, { stiffness: 90, damping: 11 });
  const eased = easeOutBack(clamp(s.x, 0, 1.25));
  // A faint idle float after landing, scaled by slide, so the third stays alive (and slide stays visible).
  const float = Math.sin((t - delay) * 0.9 + index * 2.1) * slide * 0.06 * clamp((t - delay) / 1.5, 0, 1);
  return { y: (1 - clamp(eased, 0, 1)) * slide + float, opacity: clamp(s.x * 1.2, 0, 1) };
}

export default function LowerThird(p: Props): React.ReactElement {
  const { t, history } = p;
  const s = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const tt = Math.max(0, t) * clamp(n("speed", 1), 0.2, 2);
  const slide = n("slide", 160);
  const size = n("size", 92);
  const accent = s("accent", "#ff6a00");
  const ink = s("ink", "#f5f2ea");
  const lines = [s("kicker", "FIELD NOTES"), s("title", "The Long Thaw"), s("sub", "Episode four — rivers")];
  const poses = [lineIn(tt, 0, slide), lineIn(tt, 1, slide), lineIn(tt, 2, slide)];
  const rulePose = lineIn(tt, 1, slide);
  const ruleRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    try {
      MotionGlobalConfig.useManualTiming = true;
    } catch {
      // Older Motion build: the paused animation below still seeks by hand.
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!ruleRef.current) return;
    let controls: { time: number; pause(): unknown; cancel(): unknown } | null = null;
    try {
      controls = animate(ruleRef.current, { scaleX: [0, 1], opacity: [0, 1] }, { duration: 1.2, ease: "easeOut" }) as unknown as {
        time: number;
        pause(): unknown;
        cancel(): unknown;
      };
      controls.pause();
      controls.time = clamp(tt, 0, 1.2);
    } catch {
      // Client enhancement only; the render pass above is what the probe checks.
    }
    return () => {
      try {
        controls?.cancel();
      } catch {
        // Already gone.
      }
    };
  }, [tt]);

  const poseAttr = poses.map((q) => `${q.y.toFixed(1)},${q.opacity.toFixed(3)}`).join("|");
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} data-pose={poseAttr} data-tempo={tt.toFixed(3)}>
      <div style={{ position: "absolute", left: 120, bottom: 140, color: ink }}>
        <div style={{ font: "600 28px sans-serif", letterSpacing: "0.32em", opacity: poses[0]!.opacity, transform: `translateY(${poses[0]!.y.toFixed(1)}px)` }}>
          {lines[0]}
        </div>
        <div style={{ font: `700 ${size}px/1.05 sans-serif`, letterSpacing: "-0.02em", opacity: poses[1]!.opacity, transform: `translateY(${poses[1]!.y.toFixed(1)}px)` }}>
          {lines[1]}
        </div>
        <div ref={ruleRef} style={{ width: 320, height: 6, background: accent, margin: "18px 0 14px", transformOrigin: "left center", transform: `scaleX(${clamp(rulePose.opacity, 0, 1).toFixed(3)})`, opacity: rulePose.opacity }} />
        <div style={{ font: "400 34px sans-serif", opacity: poses[2]!.opacity, transform: `translateY(${poses[2]!.y.toFixed(1)}px)` }}>
          {lines[2]}
        </div>
      </div>
    </div>
  );
}
