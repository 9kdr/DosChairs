/**
 * Dither Reveal (gold module): a Paper dithering shader confined to the
 * title band, wiped away over the reveal seconds to uncover the title.
 * Pixels outside the band stay transparent.
 *
 * Seeking: the Paper mount is parked at speed 0 and pinned with
 * `setFrame(t * 1000 * speed)`; the wipe itself is pure CSS (`clip-path`
 * from `t / reveal`), so the render pass — the one the determinism probe
 * reads — carries the whole animation in SSR markup. Mirror attributes
 * (`data-frame`, `data-wipe`) carry every prop.
 */
import React from "react";
import { ShaderMount, ditheringFragmentShader, getShaderColorFromString } from "@paper-design/shaders";
import type { EffectProps, PropSpec } from "@chair/effects";
import { PAPER_PATTERN_SIZING, clamp, num } from "@chair/effects";

export const meta = {
  id: "dither-reveal",
  name: "Dither Reveal",
  kind: "generator",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  colorBack: { type: "color", default: "#101018", title: "Dither Back" },
  colorFront: { type: "color", default: "#ff6a00", title: "Dither Front" },
  shape: { type: "number", min: 1, max: 7, default: 3, title: "Pattern" },
  size: { type: "number", min: 1, max: 12, default: 4, title: "Cell Size" },
  speed: { type: "number", min: 0, max: 3, default: 0.5, title: "Flow Speed" },
  reveal: { type: "number", min: 2, max: 8, default: 5, title: "Reveal (s)" },
  label: { type: "string", default: "Liquid Light", title: "Title" },
  backdrop: { type: "boolean", default: false, title: "Backdrop Fill" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  colorBack: string;
  colorFront: string;
  shape: number;
  size: number;
  speed: number;
  reveal: number;
  label: string;
  backdrop: boolean;
}>;

export default function DitherReveal(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const shape = Math.round(clamp(n("shape", 3), 1, 7));
  const size = clamp(n("size", 4), 1, 12);
  const frame = Math.round(Math.max(0, t) * 1000 * clamp(n("speed", 0.5), 0, 3));
  const wipe = clamp(t / Math.max(0.5, n("reveal", 5)), 0, 1);
  const label = c("label", "Liquid Light");
  const backdrop = history("backdrop", t) === true;
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mountRef = React.useRef<ShaderMount | null>(null);

  const uniforms = {
    colorBack: c("colorBack", "#101018"),
    colorFront: c("colorFront", "#ff6a00"),
    shape,
    size,
  };

  React.useLayoutEffect(() => {
    if (!hostRef.current) return;
    try {
      if (!mountRef.current) {
        // Paper only queries uniform locations for keys passed here; every key
        // the effect later sets must be present, or the dither stays blank.
        // PAPER_PATTERN_SIZING: the dithering fragment divides by u_scale
        // itself — without it the pattern collapses to a solid fill.
        mountRef.current = new ShaderMount(hostRef.current, ditheringFragmentShader, {
          ...PAPER_PATTERN_SIZING,
          u_colorBack: getShaderColorFromString(uniforms.colorBack),
          u_colorFront: getShaderColorFromString(uniforms.colorFront),
          u_shape: uniforms.shape,
          u_type: 4,
          u_pxSize: uniforms.size,
        }, undefined, 0, frame);
      }
      const mount = mountRef.current;
      mount.setUniforms({
        u_colorBack: getShaderColorFromString(uniforms.colorBack),
        u_colorFront: getShaderColorFromString(uniforms.colorFront),
        u_shape: uniforms.shape,
        u_type: 4,
        u_pxSize: uniforms.size,
      });
      mount.setSpeed(0);
      mount.setFrame(frame);
    } catch {
      // No WebGL on this host: the mirrored markup still describes the frame.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, uniforms.colorBack, uniforms.colorFront, uniforms.shape, uniforms.size]);

  React.useLayoutEffect(() => () => {
    mountRef.current?.dispose();
    mountRef.current = null;
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: backdrop ? c("colorBack", "#101018") : "transparent",
      }}
      data-frame={frame}
      data-wipe={wipe.toFixed(4)}
      data-pattern={`${shape}:${size}`}
      data-ink={`${uniforms.colorBack}|${uniforms.colorFront}`}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "600 120px sans-serif",
          color: "#101018",
          letterSpacing: "-0.02em",
        }}
      >
        {label}
      </div>
      <div
        ref={hostRef}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "36%",
          height: "28%",
          clipPath: `inset(0 ${wipe * 100}% 0 0)`,
        }}
      />
    </div>
  );
}
