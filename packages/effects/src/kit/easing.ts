/** Pure easing and interpolation helpers. */

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Map v from [a, b] to [c, d], clamped. */
export function remap(v: number, a: number, b: number, c: number, d: number): number {
  return lerp(c, d, clamp((v - a) / (b - a || 1)));
}

export function smoothstep(a: number, b: number, v: number): number {
  const u = clamp((v - a) / (b - a || 1));
  return u * u * (3 - 2 * u);
}

export const easeOutCubic = (u: number): number => 1 - Math.pow(1 - clamp(u), 3);
export const easeInCubic = (u: number): number => Math.pow(clamp(u), 3);
export const easeInOutCubic = (u: number): number => {
  const x = clamp(u);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutBack = (u: number, overshoot = 1.70158): number => {
  const x = clamp(u);
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + overshoot * Math.pow(x - 1, 2);
};
export const easeOutElastic = (u: number): number => {
  const x = clamp(u);
  if (x === 0 || x === 1) return x;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};

export const EASINGS = {
  linear: (u: number) => clamp(u),
  easeOutCubic,
  easeInCubic,
  easeInOutCubic,
  easeOutBack: (u: number) => easeOutBack(u),
  easeOutElastic,
} as const;

export type EasingName = keyof typeof EASINGS;
