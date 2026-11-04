/**
 * Scope enforcement: a piece does only the effect it was asked for. From one
 * server-rendered mid frame the probe reports two facts — which elements
 * paint a full-frame opaque fill, and what visible text the frame carries —
 * and `scopeErrors` turns them into check errors unless the brief asked for
 * a background or text. Canvases are skipped: WebGL coverage cannot be read
 * from markup, so shader fills are reviewed by eye, not by this file.
 */

export interface ScopeFlags {
  wantsBackground: boolean;
  wantsText: boolean;
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g;
const STYLE_RE = /(?:^|;)\s*style\s*=\s*("([^"]*)"|'([^']*)')/i;
const BG_RE = /background(?:-color)?\s*:\s*([^;]+)/i;

/** A `background:` value that still lets footage through. */
export function isTransparentBackground(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none" || v === "transparent" || v === "inherit" || v === "initial") return true;
  if (/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)/.test(v)) return true;
  return false;
}

/** True when the style paints an opaque full-frame fill. */
function isCoveringFill(style: string): string | null {
  const bg = BG_RE.exec(style);
  if (!bg || isTransparentBackground(bg[1]!)) return null;
  const s = style.toLowerCase();
  const covers =
    /inset\s*:\s*0/.test(s) ||
    (/top\s*:\s*0/.test(s) && /left\s*:\s*0/.test(s) && /width\s*:\s*100%/.test(s) && /height\s*:\s*100%/.test(s));
  if (!covers) return null;
  return bg[1]!.trim().slice(0, 80);
}

function styleOf(attrs: string): string {
  const m = STYLE_RE.exec(attrs);
  return (m?.[2] ?? m?.[3] ?? "").replace(/\s+/g, " ");
}

/**
 * One line per element that paints a full-frame opaque fill: the root when
 * it carries an opaque background, and any inset:0 absolutely-positioned
 * element with one. The first entry reads as the frame verdict.
 */
export function describeCovers(html: string): string[] {
  const covers: string[] = [];
  let first = true;
  for (const match of html.matchAll(TAG_RE)) {
    const tag = match[1]!.toLowerCase();
    if (tag === "canvas") {
      first = false;
      continue;
    }
    const style = styleOf(match[2] ?? "");
    if (!style) {
      first = false;
      continue;
    }
    const bg = BG_RE.exec(style);
    if (first && bg && !isTransparentBackground(bg[1]!)) {
      covers.push(`root <${tag}> fills the frame (background: ${bg[1]!.trim().slice(0, 80)})`);
    } else {
      const fill = isCoveringFill(style);
      if (fill) covers.push(`<${tag}> covers the frame (background: ${fill})`);
    }
    first = false;
  }
  return covers;
}

const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": "\u00a0",
};

/** Visible text in server-rendered markup, collapsed, at most 200 chars. */
export function extractText(html: string): string {
  const noScript = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const noTags = noScript.replace(/<[^>]*>/g, " ");
  const decoded = noTags.replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (m) => ENTITY[m] ?? m);
  return decoded.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Scope violations as check errors. Null flags mean "not asked" (reference
 * modules, hand imports, library golds): no opinion, no errors.
 */
export function scopeErrors(
  covers: string[],
  text: string,
  flags: ScopeFlags | null | undefined,
): string[] {
  if (!flags) return [];
  const errors: string[] = [];
  if (covers.length > 0 && !flags.wantsBackground) {
    errors.push(
      `fully opaque frame (${covers[0]}) but the brief asks for no background: ` +
        "render only the element on a transparent background, or gate any fill behind " +
        "a backdrop prop that defaults off",
    );
  }
  if (text.length > 0 && !flags.wantsText) {
    errors.push(
      `visible text ("${text.slice(0, 80)}") but the brief asks for no text: ` +
        "remove it (Resolve has Text+ for titles)",
    );
  }
  return errors;
}
