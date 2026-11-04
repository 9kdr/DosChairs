/**
 * The sleepy-chair scene: a night sky, a crescent moon, and a black office
 * chair snoring "z z Z". Pure pixel code with no DOM, so it renders into any
 * Uint32Array and can be tested in node. The React shell lives in
 * `sleepy-chair.tsx`.
 *
 * Every size works because the scene is laid out from the grid it is given
 * (width x height in art pixels) and the shell picks the art-pixel size.
 */

/** Packed pixel, little-endian ABGR (what ImageData wants). */
export type Pixel = number;

const rgb = (r: number, g: number, b: number): Pixel =>
  ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const hex = (v: number): Pixel => rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);

function mix(a: Pixel, b: Pixel, t: number): Pixel {
  const k = Math.min(1, Math.max(0, t));
  const r = (a & 255) + ((b & 255) - (a & 255)) * k;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k;
  const bl = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k;
  return rgb(Math.round(r), Math.round(g), Math.round(bl));
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
/** 4x4 ordered-dither threshold in (0, 1). */
const bayer = (x: number, y: number): number =>
  ((BAYER[((y & 3) << 2) | (x & 3)] ?? 0) + 0.5) / 16;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── palette ────────────────────────────────────────────────────────────────

/** Sky from the zenith down to the horizon glow. */
const SKY = [0x0d0d1c, 0x13132a, 0x1b1a3b, 0x26234f, 0x34306a].map(hex);
/** Ground from the horizon down. */
const GROUND = [0x25224d, 0x181634, 0x0f0e22].map(hex);
const HILL_FAR = hex(0x1b1a3a);
const HILL_NEAR = hex(0x151432);
const GLOW = hex(0x7d70c8);
const SHADOW = hex(0x0a0918);
const STAR_LEVELS = [0x6b6a99, 0x8c8bb8, 0xb4b3d8, 0xf0f0ff].map(hex);
const STAR_WARM = [0x8a7f78, 0xb0a287, 0xd9c99a, 0xfff1c4].map(hex);
const MOON_LIGHT = hex(0xfff1bd);
const MOON_MID = hex(0xf2d98d);
const MOON_EDGE = hex(0xd9b36a);
const MOON_DARK = hex(0x0d0d1e);
const MOON_DARK_RIM = hex(0x181832);
const ZZZ = hex(0xf4e9c8);
const SHOOT = [0xffffff, 0xd8dcff, 0x9ea4e8, 0x5b5a99].map(hex);
/** The chair is pure black. Nothing else is ever painted over it. */
export const CHAIR_BLACK: Pixel = rgb(0, 0, 0);

// ── sprites ────────────────────────────────────────────────────────────────

/** Office chair, side view, black. `#` is chair. */
const CHAIR = [
  "..........####..",
  ".........######.",
  ".........######.",
  ".........######.",
  ".........######.",
  ".........######.",
  ".........######.",
  ".........######.",
  "..........#####.",
  "..#####...#####.",
  "......#...####..",
  "......#....###..",
  "......#....###..",
  ".#############..",
  "###############.",
  ".#############..",
  "....#########...",
  ".......##.......",
  ".......##.......",
  ".......##.......",
  ".......##.......",
  "..#....##....#..",
  "..###########...",
  ".###..#####..###",
  ".##....###....##",
  ".##....###....##",
] as const;
const CHAIR_W = 16;
const CHAIR_H = CHAIR.length;

/** Z glyphs, small to large. The snore grows as it floats up. */
const ZEES = [
  ["####", "..#.", ".#..", "####"],
  ["#####", "...#.", "..#..", ".#...", "#####"],
  ["#######", ".....##", "....##.", "...##..", "..##...", ".##....", "#######"],
] as const;

// ── scene ──────────────────────────────────────────────────────────────────

interface Star {
  u: number;
  v: number;
  /** 0 dim, 1 bright, 2 sparkle (grows a cross at its peak). */
  kind: 0 | 1 | 2;
  warm: boolean;
  phase: number;
  speed: number;
  /** Parallax depth, 0 far to 2 near. */
  layer: 0 | 1 | 2;
}

interface Zzz {
  born: number;
  x: number;
  y: number;
  drift: number;
  phase: number;
}

interface Shooter {
  start: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Scene {
  w: number;
  h: number;
  horizon: number;
  time: number;
  chair: { x: number; bottom: number };
  moon: { x: number; y: number; r: number };
  stars: Star[];
  zzz: Zzz[];
  shooters: Shooter[];
  nextZ: number;
  nextShooter: number;
  /** Seconds since the chair was poked awake, or null. */
  startledAt: number | null;
  /** Seconds since the moon was poked, or null. */
  moonPulseAt: number | null;
  /** Pointer in grid coordinates, or null when it is away. */
  pointer: { x: number; y: number } | null;
  /** Eased pointer parallax, -0.5 to 0.5. */
  parallax: number;
  rand: () => number;
}

const STAR_POOL = 420;
const Z_LIFE = 3.6;
const MAX_ZZZ = 8;

/**
 * Lay the scene out for a `w` x `h` grid. Stable: same size, same sky.
 * `reserve` is how many rows at the bottom stay free of the chair, for a label.
 */
export function createScene(w: number, h: number, time = 0, reserve = 0): Scene {
  const usable = Math.max(12, h - reserve);
  const horizon = Math.round(usable * 0.8);
  const moonR = clamp(Math.round(h * 0.13), 4, 14);
  const moonX = clamp(Math.round(w * 0.8), moonR + 3, Math.max(moonR + 3, w - moonR - 3));
  const moonY = clamp(Math.round(h * 0.27), moonR + 3, Math.max(moonR + 3, horizon - moonR - 3));
  const chairX = clamp(Math.round(w * 0.3) - 8, 2, Math.max(2, w - CHAIR_W - 2));
  const bottom = Math.min(usable - 1, horizon + Math.max(2, Math.round(usable * 0.05)));

  const starRand = mulberry32(7);
  const pool: Star[] = [];
  for (let i = 0; i < STAR_POOL; i += 1) {
    const roll = starRand();
    pool.push({
      u: starRand(),
      v: starRand(),
      kind: roll < 0.7 ? 0 : roll < 0.92 ? 1 : 2,
      warm: starRand() < 0.18,
      phase: starRand() * Math.PI * 2,
      speed: 0.6 + starRand() * 1.8,
      layer: Math.min(2, Math.floor(starRand() * 3)) as 0 | 1 | 2,
    });
  }
  const count = clamp(Math.round((w * h) / 75), 10, STAR_POOL);

  const rand = mulberry32(2024 + w * 31 + h);
  return {
    w,
    h,
    horizon,
    time,
    chair: { x: chairX, bottom },
    moon: { x: moonX, y: moonY, r: moonR },
    stars: pool.slice(0, count),
    zzz: [],
    shooters: [],
    nextZ: time + 0.6,
    nextShooter: time + 4 + rand() * 4,
    startledAt: null,
    moonPulseAt: null,
    pointer: null,
    parallax: 0,
    rand,
  };
}

/** Where the snore starts: just above the backrest. */
function mouth(scene: Scene): { x: number; y: number } {
  return { x: scene.chair.x + 11, y: scene.chair.bottom - CHAIR_H - 6 };
}

function spawnZ(scene: Scene, at: number): void {
  if (scene.zzz.length >= MAX_ZZZ) return;
  const m = mouth(scene);
  scene.zzz.push({
    born: at,
    x: m.x,
    y: m.y,
    drift: 7 + scene.rand() * 7,
    phase: scene.rand() * Math.PI * 2,
  });
}

function spawnShooter(scene: Scene, x: number, y: number, delay = 0): void {
  scene.shooters.push({
    start: scene.time + delay,
    x,
    y,
    vx: -(46 + scene.rand() * 22),
    vy: 20 + scene.rand() * 12,
  });
}

/** Advance the scene by `dt` seconds. */
export function step(scene: Scene, dt: number): void {
  scene.time += dt;
  const t = scene.time;

  if (t >= scene.nextZ) {
    spawnZ(scene, t);
    scene.nextZ = t + 1.35 + scene.rand() * 0.5;
  }
  scene.zzz = scene.zzz.filter((z) => t - z.born < Z_LIFE);

  if (t >= scene.nextShooter) {
    spawnShooter(scene, scene.w * (0.55 + scene.rand() * 0.5), scene.rand() * scene.h * 0.3);
    scene.nextShooter = t + 7 + scene.rand() * 8;
  }
  scene.shooters = scene.shooters.filter((s) => {
    const age = t - s.start;
    if (age < 0) return true;
    return s.x + s.vx * age > -12 && s.y + s.vy * age < scene.horizon;
  });

  if (scene.startledAt !== null) {
    scene.startledAt += dt;
    if (scene.startledAt > 0.4) scene.startledAt = null;
  }
  if (scene.moonPulseAt !== null) {
    scene.moonPulseAt += dt;
    if (scene.moonPulseAt > 1.6) scene.moonPulseAt = null;
  }

  const target = scene.pointer ? scene.pointer.x / scene.w - 0.5 : 0;
  scene.parallax += (target - scene.parallax) * Math.min(1, dt * 6);
}

export type Hit = "chair" | "moon" | "sky";

/** What sits under a grid point. Used for the pointer cursor and for clicks. */
export function hitTest(scene: Scene, x: number, y: number): Hit {
  const { chair, moon } = scene;
  const top = chair.bottom - CHAIR_H;
  if (x >= chair.x - 2 && x <= chair.x + CHAIR_W + 2 && y >= top - 2 && y <= chair.bottom + 1) {
    return "chair";
  }
  if (Math.hypot(x - moon.x, y - moon.y) <= moon.r + 3) return "moon";
  return "sky";
}

/** A click: wake the chair, pulse the moon, or send a shooting star. */
export function poke(scene: Scene, x: number, y: number): Hit {
  const hit = hitTest(scene, x, y);
  if (hit === "chair") {
    scene.startledAt = 0;
    spawnZ(scene, scene.time);
    spawnZ(scene, scene.time - 0.5);
    spawnZ(scene, scene.time - 1);
    scene.nextZ = scene.time + 1.2;
  } else if (hit === "moon") {
    scene.moonPulseAt = 0;
    spawnShooter(scene, scene.moon.x, scene.moon.y);
    spawnShooter(scene, scene.moon.x + 4, scene.moon.y - 3, 0.25);
    spawnShooter(scene, scene.moon.x - 3, scene.moon.y - 5, 0.5);
  } else if (y < scene.horizon - 4) {
    spawnShooter(scene, x, y);
  }
  return hit;
}

// ── drawing ────────────────────────────────────────────────────────────────

function put(buf: Uint32Array, w: number, h: number, x: number, y: number, c: Pixel): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= w || py >= h) return;
  buf[py * w + px] = c;
}

function skyAt(x: number, y: number, horizon: number): Pixel {
  const v = clamp(y / Math.max(1, horizon), 0, 1) * (SKY.length - 1);
  const i = Math.min(SKY.length - 2, Math.floor(v));
  const f = v - i;
  return (f > bayer(x, y) ? SKY[i + 1] : SKY[i]) ?? SKY[0] ?? 0;
}

function groundAt(x: number, y: number, scene: Scene): Pixel {
  const span = Math.max(1, scene.h - scene.horizon);
  const v = clamp((y - scene.horizon) / span, 0, 1) * (GROUND.length - 1);
  const i = Math.min(GROUND.length - 2, Math.floor(v));
  const f = v - i;
  return (f > bayer(x, y) ? GROUND[i + 1] : GROUND[i]) ?? GROUND[0] ?? 0;
}

/** Hill top for column x. Flattens near the chair so it keeps a bright backdrop. */
function hillTop(scene: Scene, x: number, far: boolean): number {
  const { h, horizon, chair } = scene;
  const clear = clamp(Math.abs(x - (chair.x + CHAIR_W / 2)) / (CHAIR_W * 1.6), 0.1, 1);
  const a = far
    ? 0.5 + 0.5 * Math.sin(x * 0.045 + 1.3)
    : 0.5 + 0.5 * Math.sin(x * 0.08 + 4.1);
  const b = far
    ? 0.5 + 0.5 * Math.sin(x * 0.11 + 4)
    : 0.5 + 0.5 * Math.sin(x * 0.17 + 0.5);
  const amp = far ? h * 0.1 : h * 0.045;
  const tall = far ? 1 : 0.8;
  return horizon - (a * amp + b * amp * 0.4) * clear * tall + (far ? 0 : 1);
}

function inMoonCrescent(scene: Scene, x: number, y: number): "none" | "dark" | "rim" | "lit" {
  const { moon } = scene;
  const dx = x - moon.x;
  const dy = y - moon.y;
  const d = Math.hypot(dx, dy);
  if (d > moon.r + 0.5) return "none";
  // The shadow disc bites the lit crescent from the right, as in the reference.
  const sx = moon.x + moon.r * 0.5;
  const sy = moon.y - moon.r * 0.1;
  const sr = moon.r * 0.98;
  const ds = Math.hypot(x - sx, y - sy);
  if (ds > sr) return "lit";
  return ds > sr - 1 ? "rim" : "dark";
}

function drawMoon(scene: Scene, buf: Uint32Array): void {
  const { moon, w, h } = scene;
  const sx = moon.x + moon.r * 0.5;
  const sy = moon.y - moon.r * 0.1;
  const sr = moon.r * 0.98;
  for (let y = Math.floor(moon.y - moon.r - 1); y <= moon.y + moon.r + 1; y += 1) {
    for (let x = Math.floor(moon.x - moon.r - 1); x <= moon.x + moon.r + 1; x += 1) {
      const kind = inMoonCrescent(scene, x, y);
      if (kind === "none") continue;
      if (kind === "dark") put(buf, w, h, x, y, MOON_DARK);
      else if (kind === "rim") put(buf, w, h, x, y, MOON_DARK_RIM);
      else {
        const edge = Math.hypot(x - sx, y - sy) - sr;
        put(buf, w, h, x, y, edge < 1.6 ? MOON_EDGE : edge < 3.2 ? MOON_MID : MOON_LIGHT);
      }
    }
  }
}

function drawGlow(scene: Scene, buf: Uint32Array): void {
  const { moon, w, h, horizon } = scene;
  const pulse =
    scene.moonPulseAt === null ? 0 : Math.sin((scene.moonPulseAt / 1.6) * Math.PI);
  const reach = moon.r * (3.2 + pulse * 1.6);
  const x0 = Math.max(0, Math.floor(moon.x - reach));
  const x1 = Math.min(w - 1, Math.ceil(moon.x + reach));
  const y0 = Math.max(0, Math.floor(moon.y - reach));
  const y1 = Math.min(horizon, Math.ceil(moon.y + reach));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - moon.x, y - moon.y);
      if (d > reach) continue;
      const strength = (1 - d / reach) ** 1.7 * (0.85 + pulse * 0.4);
      if (strength > bayer(x, y)) {
        buf[y * w + x] = mix(skyAt(x, y, horizon), GLOW, 0.4 + pulse * 0.15);
      }
    }
  }
}

function drawStars(scene: Scene, buf: Uint32Array): void {
  const { w, h, horizon, time, pointer, parallax, moon } = scene;
  for (const star of scene.stars) {
    const shift = Math.round(parallax * star.layer * 4);
    const x = Math.floor(star.u * w) + shift;
    const y = Math.floor(star.v * (horizon - 3));
    if (Math.hypot(x - moon.x, y - moon.y) <= moon.r + 1) continue;
    const wave = Math.sin(time * star.speed + star.phase);
    let level = (star.kind === 0 ? 0 : star.kind === 1 ? 2 : 3) + Math.round(wave * 1.2);
    let cross = false;
    if (pointer) {
      const d = Math.hypot(x - pointer.x, y - pointer.y);
      if (d < 10) {
        level += 2;
        cross = d < 6;
      }
    }
    level = clamp(level, 0, 3);
    cross = cross || (star.kind === 2 && level >= 3);
    const palette = star.warm ? STAR_WARM : STAR_LEVELS;
    const c = palette[level] ?? STAR_LEVELS[0] ?? 0;
    put(buf, w, h, x, y, c);
    if (cross && level >= 2) {
      const arm = palette[1] ?? c;
      put(buf, w, h, x - 1, y, arm);
      put(buf, w, h, x + 1, y, arm);
      put(buf, w, h, x, y - 1, arm);
      put(buf, w, h, x, y + 1, arm);
    }
  }
}

function drawLand(scene: Scene, buf: Uint32Array): void {
  const { w, h, horizon } = scene;
  for (let x = 0; x < w; x += 1) {
    const far = Math.round(hillTop(scene, x, true));
    const near = Math.round(hillTop(scene, x, false));
    for (let y = Math.max(0, far); y < h; y += 1) {
      const c = y < near ? HILL_FAR : y < horizon ? HILL_NEAR : groundAt(x, y, scene);
      buf[y * w + x] = c;
    }
  }
}

function chairOffset(scene: Scene): number {
  const t = scene.startledAt;
  if (t === null) return 0;
  return t < 0.1 ? -3 : t < 0.2 ? -2 : t < 0.3 ? -1 : 0;
}

function drawChair(scene: Scene, buf: Uint32Array): void {
  const { w, h, chair } = scene;
  // A flat dithered shadow on the ground under the casters.
  const cx = chair.x + CHAIR_W / 2;
  for (let y = chair.bottom - 1; y <= chair.bottom + 1; y += 1) {
    const half = y === chair.bottom ? 11 : 8;
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x += 1) {
      if ((x + y) % 2 === 0) put(buf, w, h, x, y, SHADOW);
    }
  }
  const top = chair.bottom - CHAIR_H + chairOffset(scene);
  CHAIR.forEach((row, ry) => {
    for (let rx = 0; rx < CHAIR_W; rx += 1) {
      if (row[rx] === "#") put(buf, w, h, chair.x + rx, top + ry, CHAIR_BLACK);
    }
  });
}

function drawZzz(scene: Scene, buf: Uint32Array): void {
  const { w, h, time } = scene;
  const rise = clamp(scene.chair.bottom - CHAIR_H - 8, 10, 46);
  for (const z of scene.zzz) {
    const age = time - z.born;
    if (age < 0) continue;
    const p = age / Z_LIFE;
    const glyph = ZEES[p < 0.3 ? 0 : p < 0.62 ? 1 : 2] ?? ZEES[0];
    const alpha = Math.min(1, p / 0.12, (1 - p) / 0.3);
    const gx = Math.round(z.x + p * z.drift + Math.sin(age * 2.2 + z.phase) * 1.6);
    const gy = Math.round(z.y - p * rise);
    glyph.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx += 1) {
        if (row[rx] !== "#") continue;
        if (alpha >= 1 || alpha > bayer(gx + rx, gy + ry)) put(buf, w, h, gx + rx, gy + ry, ZZZ);
      }
    });
  }
}

function drawShooters(scene: Scene, buf: Uint32Array): void {
  const { w, h, time } = scene;
  for (const s of scene.shooters) {
    const age = time - s.start;
    if (age < 0) continue;
    const hx = s.x + s.vx * age;
    const hy = s.y + s.vy * age;
    const len = Math.hypot(s.vx, s.vy);
    const ux = -s.vx / len;
    const uy = -s.vy / len;
    for (let i = 0; i < 9; i += 1) {
      const c = SHOOT[Math.min(SHOOT.length - 1, Math.floor(i / 2.4))] ?? SHOOT[0] ?? 0;
      if (i > 5 && (i + Math.round(hx)) % 2 === 0) continue;
      put(buf, w, h, hx + ux * i, hy + uy * i, c);
    }
  }
}

/** Paint the whole scene into `buf` (length `scene.w * scene.h`). */
export function render(scene: Scene, buf: Uint32Array): void {
  const { w, h, horizon } = scene;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      buf[y * w + x] = y < horizon ? skyAt(x, y, horizon) : groundAt(x, y, scene);
    }
  }
  drawGlow(scene, buf);
  drawStars(scene, buf);
  drawMoon(scene, buf);
  drawShooters(scene, buf);
  drawLand(scene, buf);
  drawChair(scene, buf);
  drawZzz(scene, buf);
}

/** The chair's footprint in grid pixels, for tests and hit boxes. */
export function chairBox(scene: Scene): { x: number; y: number; w: number; h: number } {
  return {
    x: scene.chair.x,
    y: scene.chair.bottom - CHAIR_H + chairOffset(scene),
    w: CHAIR_W,
    h: CHAIR_H,
  };
}

/** True where the sprite has a black pixel. */
export function chairHas(rx: number, ry: number): boolean {
  return CHAIR[ry]?.[rx] === "#";
}
