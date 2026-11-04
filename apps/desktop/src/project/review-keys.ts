/**
 * Keyboard-first review (#146): the pure key map behind the review board.
 * j/k and the arrows move between proposal items, a/r decide the focused
 * item, u (and Ctrl/Cmd+Z) undoes the last decision, Enter expands the
 * details, and ? opens the shortcut overlay. Accept stays explicit: one
 * key decides one item; there is no key for accept-all.
 */

export type ReviewKeyAction =
  | "next"
  | "prev"
  | "accept"
  | "reject"
  | "undo"
  | "toggle"
  | "help";

export type ReviewKeyPress = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/**
 * Map one keypress to its review action. Unknown keys return null.
 * Modified keys never decide: Ctrl/Cmd+Z is undo, everything else with
 * a modifier is left to the browser (so Ctrl+A still selects).
 */
export function reviewKeyAction(press: ReviewKeyPress): ReviewKeyAction | null {
  if (press.ctrlKey || press.metaKey) {
    if (!press.shiftKey && press.key.toLowerCase() === "z") return "undo";
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
 * True when review keys may fire for this event target. Typing stays
 * untouched: inputs, selects, textareas, editable text, and anything
 * inside an open dialog or menu never triggers a review key.
 * Duck-typed on closest/isContentEditable so tests run without a DOM.
 */
export function reviewKeyAllowed(target: unknown): boolean {
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
 * The board leaves Enter alone there and only toggles details from
 * a focused row itself, so one press never does two jobs.
 */
export function reviewKeyNativeEnter(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const candidate = target as { closest?: unknown };
  if (typeof candidate.closest !== "function") return false;
  return (
    (candidate.closest as (selector: string) => unknown).call(target, "button, a") !== null
  );
}

/**
 * Clamp a focus move into the item list. An empty list reads as no
 * focus (-1); otherwise the index stays on the first or last item.
 */
export function moveReviewFocus(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export type ReviewShortcut = {
  keys: string[];
  label: string;
};

/** Every shortcut the board answers to, rendered by the hint row and the ? overlay. */
export const REVIEW_SHORTCUTS: ReviewShortcut[] = [
  { keys: ["j", "↓"], label: "Next proposal" },
  { keys: ["k", "↑"], label: "Previous proposal" },
  { keys: ["a"], label: "Accept the focused proposal" },
  { keys: ["r"], label: "Reject the focused proposal" },
  { keys: ["u", "Ctrl/⌘ Z"], label: "Undo the last decision" },
  { keys: ["Enter"], label: "Expand the focused proposal" },
  { keys: ["?"], label: "Show all shortcuts" },
];
