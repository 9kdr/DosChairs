/** Effect spec types. Mirror schemas/effect-spec.schema.json. */

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";

export interface Keyframe {
  time: number;
  value: number;
  easing?: Easing;
  /** [dtSec, dv] Bezier handle into this key, Resolve Bezierspline form. */
  inHandle?: [number, number];
  /** [dtSec, dv] Bezier handle out of this key, Resolve Bezierspline form. */
  outHandle?: [number, number];
}

export interface Curve {
  keyframes: Keyframe[];
}

export type LayerType = "shape" | "text" | "image" | "shader";
export type BlendMode = "normal" | "add" | "multiply" | "screen";

export interface Layer {
  id: string;
  type: LayerType;
  name?: string;
  /** Static params; animated ones move to curves. */
  params?: Record<string, string | number | boolean>;
  /** Animated property name to keyframed curve. */
  curves?: Record<string, Curve>;
  blend?: BlendMode;
  visible?: boolean;
}

export type ControlType = "number" | "color" | "text" | "bool";

export interface Control {
  id: string;
  label: string;
  type: ControlType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  /** Which layer param this published control drives. */
  target: { layerId: string; param: string };
}

export interface EffectShader {
  /** GLSL ES 3.00 fragment shader source. */
  source: string;
  /** Binds a shader uniform to a published control. */
  uniforms?: { name: string; controlId: string }[];
}

export interface RigPathKey {
  time: number;
  x: number;
  y: number;
}

export interface Rig {
  /** Rough position path keyed by the user in Resolve. */
  inputPath: RigPathKey[];
  stiffness?: number;
  damping?: number;
  mass?: number;
  swing?: boolean;
  tilt?: boolean;
  squash?: boolean;
  overshoot?: boolean;
}

export type ExportTarget = "fusion-macro" | "fusion-fuse" | "rendered-clip" | "ograf";

export interface EffectExport {
  /** Most native Resolve target that can express this spec. */
  target: ExportTarget;
  /** Set when the preferred target was not possible. */
  fallback?: { capability: string; reason: string };
}

export interface EffectSpec {
  schemaVersion: "0.1.0";
  id: string;
  name: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  layers: Layer[];
  controls?: Control[];
  shader?: EffectShader;
  rig?: Rig;
  export?: EffectExport;
}

/** One baked/simulated frame of secondary motion. */
export interface RigFrame {
  time: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** Uniform per-frame samples for one animated property. */
export interface Sample {
  t: number;
  v: number;
}
