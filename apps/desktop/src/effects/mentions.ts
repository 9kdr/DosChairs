/**
 * The `@` in the Effect Maker brief: find the mention under the caret, and
 * swap it for a compact tag once the editor picks a piece. Pure text work,
 * so the menu logic can be tested without a DOM.
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

/** `Camera Shake` becomes `@CameraShake`: one word the model reads as a name. */
export function mentionTag(label: string): string {
  return `@${label.replace(/[^\p{L}\p{N}_-]+/gu, "")}`;
}

/** Replace the typed `@query` with the tag and a trailing space; returns the new caret. */
export function insertMention(text: string, mention: Mention, label: string): { text: string; caret: number } {
  const tag = `${mentionTag(label)} `;
  const after = text.slice(mention.end).replace(/^ /, "");
  return { text: text.slice(0, mention.start) + tag + after, caret: mention.start + tag.length };
}
