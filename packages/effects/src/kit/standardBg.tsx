/**
 * The standard transparency switch. The probe and the bundler add these two
 * props to every non-background piece and wrap its frame in `StandardBg`;
 * modules never hand-write them, so the ids are the same everywhere and the
 * switch is a normal Inspector prop (keyframes, bake, and history all flow
 * through it). Background-kind pieces are the backdrop already and skip it.
 */
import React from "react";
import type { History, PropSpec } from "./types.js";

const BG_DEFAULT = "#0e0e10";

export const STANDARD_SWITCH_PROPS: Record<string, PropSpec> = {
  transparentBg: { type: "boolean", default: true, title: "Transparent background" },
  backgroundColor: { type: "color", default: BG_DEFAULT, title: "Background color" },
};

/**
 * Paint the backing fill behind the piece when the switch is off, nothing
 * when it is on. The data attributes mirror both props so the determinism
 * probe sees the switch move even while the fill is off.
 */
export function StandardBg(p: { t: number; history: History; children: React.ReactNode }): React.ReactElement {
  const transparent = p.history("transparentBg", p.t) ?? true;
  const color = String(p.history("backgroundColor", p.t) ?? BG_DEFAULT);
  return (
    <div style={{ position: "absolute", inset: 0 }} data-std-bg={transparent ? "off" : "on"} data-std-color={color}>
      {!transparent && <div style={{ position: "absolute", inset: 0, background: color }} />}
      {p.children}
    </div>
  );
}
