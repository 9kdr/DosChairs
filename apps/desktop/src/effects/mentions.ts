/**
 * The `@` in any input bar: find the mention under the caret so the
 * picker can offer footage, assets, pieces and plan references. Pure
 * text work, so the menu logic can be tested without a DOM.
 */

export type Mention = {
  /** Index of the `@`. */
  start: number;
  /** Index just after the typed query (the caret). */
  end: number;
  /** What was typed after the `@`. */
  query: string;
};

/** An `@` at the start or after whitespace, with no space between it and the caret. */
export function findMention(text: string, caret: number): Mention | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, end: before.length, query };
}

/** The bar's editor pieces, structurally: text runs and one-slot chips. */
export type MentionPiece = { type: "text"; value: string } | { type: "ref" };

/** One slot per chip: U+FFFC OBJECT REPLACEMENT CHARACTER. */
const CHIP_SLOT = "\uFFFC";

/**
 * The text before the caret as the mention finder reads it: text runs
 * verbatim, each chip as one placeholder slot. Offsets line up with the
 * editor's caret, so a mention's start/end can replace that range with
 * the picked chip.
 */
export function textBeforeCaret(pieces: readonly MentionPiece[], caret: number): string {
  let left = Math.max(0, caret);
  let out = "";
  for (const piece of pieces) {
    if (left <= 0) break;
    if (piece.type === "ref") {
      out += CHIP_SLOT;
      left -= 1;
    } else {
      out += piece.value.slice(0, left);
      left -= piece.value.length;
    }
  }
  return out;
}
