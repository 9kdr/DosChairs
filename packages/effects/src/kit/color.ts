/** Color helpers. Fusion hands colors over as lowercase `#rrggbb` strings. */

/** `#rgb` or `#rrggbb` to [r, g, b] in 0..1; white when unparseable. */
export function hexToRgb01(hex: unknown): [number, number, number] {
  let h = typeof hex === "string" && hex.startsWith("#") ? hex.slice(1) : "";
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** `#rrggbb` to a CSS rgba() string at the given alpha. */
export function hexToRgba(hex: unknown, alpha = 1): string {
  const [r, g, b] = hexToRgb01(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** Blend two hex colors; u = 0 gives a, u = 1 gives b. Returns `#rrggbb`. */
export function mixHex(a: unknown, b: unknown, u: number): string {
  const ca = hexToRgb01(a);
  const cb = hexToRgb01(b);
  const to = (i: number) =>
    Math.round((ca[i]! + (cb[i]! - ca[i]!) * Math.min(1, Math.max(0, u))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(0)}${to(1)}${to(2)}`;
}
