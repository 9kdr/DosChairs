/**
 * Keyboard-first history (#230, from #146): the pure key map behind the
 * history card. j/k and the arrows move between entries, u (and
 * Ctrl/Cmd+Z) undoes the last entry, Shift+U undoes to the focused
 * entry, Enter expands the details, and ? opens the shortcut overlay.
 * There is nothing to decide — edits land on arrival — so the a/r
 * mapping below stays only until HistoryCard's dead branch goes; the
 * overlay no longer lists them.
 */

export type HistoryKeyAction =
  | "next"
  | "prev"
  | "accept"
  | "reject"
  | "undo"
  | "undoHere"
  | "toggle"
  | "help";

export type HistoryKeyPress = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/**
 * Map one keypress to its history action. Unknown keys return null.
 * Modified keys never decide: Ctrl/Cmd+Z is undo, Shift+U is undo to
 * here, everything else with a modifier is left to the browser (so
 * Ctrl+A still selects).
 */
export function historyKeyAction(press: HistoryKeyPress): HistoryKeyAction | null {
  if (press.ctrlKey || press.metaKey) {
    if (!press.shiftKey && press.key.toLowerCase() === "z") return "undo";
    return null;
  }
  if (press.shiftKey) {
    if (press.key.toLowerCase() === "u") return "undoHere";
    return null;
  }
  switch (press.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "prev";
    case "a":
      return "accept";
    case "r":
      return "reject";
    case "u":
      return "undo";
    case "Enter":
      return "toggle";
    case "?":
      return "help";
    default:
      return null;
  }
}

/**
 * True when history keys may fire for this event target. Typing stays
 * untouched: inputs, selects, textareas, editable text, and anything
 * inside an open dialog or menu never triggers a history key.
 * Duck-typed on closest/isContentEditable so tests run without a DOM.
 */
export function historyKeyAllowed(target: unknown): boolean {
  if (target === null || typeof target !== "object") return true;
  const candidate = target as {
    isContentEditable?: unknown;
    closest?: unknown;
  };
  if (candidate.isContentEditable === true) return false;
  if (typeof candidate.closest === "function") {
    const match = (candidate.closest as (selector: string) => unknown).call(
      target,
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
    );
    if (match !== null) return false;
  }
  return true;
}

/**
 * True when the target may use Enter natively (a button or a link).
 * The card leaves Enter alone there and only toggles details from
 * a focused row itself, so one press never does two jobs.
 */
export function historyKeyNativeEnter(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const candidate = target as { closest?: unknown };
  if (typeof candidate.closest !== "function") return false;
  return (
    (candidate.closest as (selector: string) => unknown).call(target, "button, a") !== null
  );
}

/**
 * Clamp a focus move into the entry list. An empty list reads as no
 * focus (-1); otherwise the index stays on the first or last entry.
 */
export function moveHistoryFocus(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export type HistoryShortcut = {
  keys: string[];
  label: string;
};

/** Every shortcut the history answers to, rendered by the hint row and the ? overlay. */
export const HISTORY_SHORTCUTS: HistoryShortcut[] = [
  { keys: ["j", "↓"], label: "Next entry" },
  { keys: ["k", "↑"], label: "Previous entry" },
  { keys: ["u", "Ctrl/⌘ Z"], label: "Undo the last entry" },
  { keys: ["Shift U"], label: "Undo to the focused entry" },
  { keys: ["Enter"], label: "Expand the focused entry" },
  { keys: ["?"], label: "Show all shortcuts" },
];
