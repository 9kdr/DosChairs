/**
 * ShaderPass: one fullscreen WebGL2 fragment pass as a React element.
 *
 * The element is a pure description of a frame: `frag` plus `uniforms` (all
 * numbers, vectors, booleans, or `#rrggbb` colors). Painting happens in a
 * layout effect on every render, so each goToTime paints exactly the frame its
 * uniforms describe, and server rendering emits a deterministic `<canvas>`
 * carrying the uniforms as data. If WebGL2 or the shader fails, a labelled
 * box shows instead of a silent black frame.
 */
import React from "react";
import { coerceUniformValue, paintFragment } from "../gl.js";
import type { BoundUniform } from "../gl.js";

export type UniformInput = number | boolean | string | number[];

export interface ShaderPassProps {
  /** GLSL ES 3.00 fragment source. Gets `in vec2 vUv` (0..1) from the kit vertex shader. */
  frag: string;
  uniforms: Record<string, UniformInput>;
  width: number;
  height: number;
}

export function boundUniforms(uniforms: Record<string, UniformInput>): BoundUniform[] {
  const out: BoundUniform[] = [];
  for (const name of Object.keys(uniforms).sort()) {
    const value = coerceUniformValue(uniforms[name]);
    if (value) out.push({ name, value });
  }
  return out;
}

export function ShaderPass({ frag, uniforms, width, height }: ShaderPassProps): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, alpha: true, antialias: false });
    const ok = !!gl && paintFragment(gl, frag, width, height, boundUniforms(uniforms));
    if (!ok && !failed) setFailed(true);
    else if (ok && failed) setFailed(false);
  });
  return (
    <>
      <canvas
        ref={ref}
        width={width}
        height={height}
        data-uniforms={JSON.stringify(uniforms)}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: failed ? "none" : "block" }}
      />
      {failed ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#202020",
            color: "#ffffff",
            font: "600 28px sans-serif",
          }}
        >
          WebGL2 unavailable or shader failed to compile
        </div>
      ) : null}
    </>
  );
}
