/**
 * Dither Reveal (gold module): the title starts as a dithering pattern and
 * resolves to solid ink over the reveal seconds. The dither lives inside
 * the text alpha; every other pixel stays transparent.
 *
 * Seeking: the Paper mount is parked at speed 0 and pinned with
 * `setFrame(t * 1000 * speed)`; a 2D composite masks the dither with the
 * title glyphs and crossfades it into solid text by `t / reveal`. The
 * render pass — the one the determinism probe reads — carries the whole
 * animation in SSR markup. Mirror attributes (`data-frame`, `data-wipe`)
 * carry every prop.
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
  ink: { type: "color", default: "#f2efe8", title: "Title Ink" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  colorBack: string;
  colorFront: string;
  shape: number;
  size: number;
  speed: number;
  reveal: number;
  label: string;
  ink: string;
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
  const ink = c("ink", "#f2efe8");
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mountRef = React.useRef<ShaderMount | null>(null);
  const compRef = React.useRef<HTMLDivElement | null>(null);
  const compCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const textCanvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const uniforms = {
    colorBack: c("colorBack", "#101018"),
    colorFront: c("colorFront", "#ff6a00"),
    shape,
    size,
  };

  React.useLayoutEffect(() => {
    if (!hostRef.current || !compRef.current) return;
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
      // The title resolves from dither to solid: mask the full-frame dither
      // with the glyphs, fade it out by the wipe, and draw the solid ink
      // over it with the same call so the two never drift apart. Paper
      // draws synchronously while parked, so its buffer reads valid here.
      const paperCanvas = hostRef.current.querySelector("canvas");
      if (paperCanvas) {
        paperCanvas.style.display = "none";
        if (!compCanvasRef.current) {
          const made = document.createElement("canvas");
          made.width = width;
          made.height = height;
          made.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
          compRef.current.appendChild(made);
          compCanvasRef.current = made;
        }
        if (!textCanvasRef.current) {
          const made = document.createElement("canvas");
          made.width = width;
          made.height = height;
          textCanvasRef.current = made;
        }
        const glyph = textCanvasRef.current.getContext("2d");
        const comp = compCanvasRef.current.getContext("2d");
        if (glyph && comp) {
          glyph.globalCompositeOperation = "source-over";
          glyph.clearRect(0, 0, width, height);
          glyph.font = "600 120px sans-serif";
          glyph.textAlign = "center";
          glyph.textBaseline = "middle";
          glyph.fillStyle = "#ffffff";
          glyph.fillText(label, width / 2, height / 2);
          comp.globalCompositeOperation = "source-over";
          comp.clearRect(0, 0, width, height);
          comp.drawImage(paperCanvas, 0, 0, width, height);
          comp.globalCompositeOperation = "destination-in";
          comp.drawImage(textCanvasRef.current, 0, 0);
          comp.globalAlpha = 1 - wipe;
          comp.fillRect(0, 0, width, height);
          comp.globalAlpha = 1;
          comp.globalCompositeOperation = "source-over";
          comp.globalAlpha = wipe;
          comp.font = "600 120px sans-serif";
          comp.textAlign = "center";
          comp.textBaseline = "middle";
          comp.fillStyle = ink;
          comp.fillText(label, width / 2, height / 2);
          comp.globalAlpha = 1;
        }
      }
    } catch {
      // No WebGL on this host: the mirrored markup still describes the frame.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, wipe, uniforms.colorBack, uniforms.colorFront, uniforms.shape, uniforms.size, label, ink]);

  React.useLayoutEffect(() => () => {
    mountRef.current?.dispose();
    mountRef.current = null;
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "transparent",
      }}
      data-frame={frame}
      data-wipe={wipe.toFixed(4)}
      data-pattern={`${shape}:${size}`}
      data-ink={`${uniforms.colorBack}|${uniforms.colorFront}|${ink}`}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "600 120px sans-serif",
          color: ink,
          letterSpacing: "-0.02em",
          opacity: 0,
        }}
      >
        {label}
      </div>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={compRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
