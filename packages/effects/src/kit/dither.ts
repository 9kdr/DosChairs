/** Ordered dither and halftone helpers (CPU and GLSL). */

export const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const BAYER8 = (() => {
  const m: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const base = BAYER4[y % 4]![x % 4]!;
      const quad = (y < 4 ? 0 : 2) + (x < 4 ? 0 : 1);
      m[y]![x] = base * 4 + [0, 2, 3, 1][quad]!;
    }
  }
  return m;
})();

/** Bayer threshold in (0, 1) for pixel (x, y); `size` is 4 or 8. */
export function bayerThreshold(x: number, y: number, size: 4 | 8 = 8): number {
  const ix = ((Math.floor(x) % size) + size) % size;
  const iy = ((Math.floor(y) % size) + size) % size;
  const n = size * size;
  const v = size === 4 ? BAYER4[iy]![ix]! : BAYER8[iy]![ix]!;
  return (v + 0.5) / n;
}

/** Ordered-dither a 0..1 tone to 0 or 1 at pixel (x, y). */
export function orderedDither(tone: number, x: number, y: number, size: 4 | 8 = 8): 0 | 1 {
  return tone > bayerThreshold(x, y, size) ? 1 : 0;
}

/** Round halftone dot coverage (0..1) at (x, y) for a tone, cell size in pixels, screen angle in radians. */
export function halftone(tone: number, x: number, y: number, cell: number, angle = 0.785398): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const u = (x * c + y * s) / cell;
  const v = (-x * s + y * c) / cell;
  const du = u - Math.round(u);
  const dv = v - Math.round(v);
  const dist = Math.sqrt(du * du + dv * dv);
  const radius = Math.sqrt(Math.max(0, Math.min(1, tone))) * 0.7071;
  return dist < radius ? 1 : 0;
}

/** GLSL ES 3.00 snippet: float bayer8(vec2 pixel) in (0, 1), float halftone(float tone, vec2 pixel, float cell, float angle). */
export const GLSL_BAYER = `
float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float x = q.x;
  float y = q.y;
  float v = 0.0;
  if (y < 0.5) v = x < 0.5 ? 0.0 : x < 1.5 ? 8.0 : x < 2.5 ? 2.0 : 10.0;
  else if (y < 1.5) v = x < 0.5 ? 12.0 : x < 1.5 ? 4.0 : x < 2.5 ? 14.0 : 6.0;
  else if (y < 2.5) v = x < 0.5 ? 3.0 : x < 1.5 ? 11.0 : x < 2.5 ? 1.0 : 9.0;
  else v = x < 0.5 ? 15.0 : x < 1.5 ? 7.0 : x < 2.5 ? 13.0 : 5.0;
  return v;
}
float bayer8(vec2 p) {
  vec2 q = mod(floor(p), 8.0);
  vec2 sub = mod(q, 4.0);
  float quad = (q.y < 4.0 ? 0.0 : 2.0) + (q.x < 4.0 ? 0.0 : 1.0);
  float off = quad < 0.5 ? 0.0 : quad < 1.5 ? 2.0 : quad < 2.5 ? 3.0 : 1.0;
  return (bayer4(sub) * 4.0 + off + 0.5) / 64.0;
}
float halftone(float tone, vec2 p, float cell, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  vec2 g = vec2(p.x * c + p.y * s, -p.x * s + p.y * c) / cell;
  vec2 d = g - floor(g + 0.5);
  float r = sqrt(clamp(tone, 0.0, 1.0)) * 0.7071;
  return length(d) < r ? 1.0 : 0.0;
}
`;
