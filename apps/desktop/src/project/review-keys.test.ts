import { describe, expect, it } from "vitest";
import {
  moveReviewFocus,
  REVIEW_SHORTCUTS,
  reviewKeyAction,
  reviewKeyAllowed,
  reviewKeyNativeEnter,
  type ReviewKeyPress,
} from "./review-keys";

function press(key: string, modifiers: Partial<ReviewKeyPress> = {}): ReviewKeyPress {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

/** A stand-in event target: closest answers whether it sits inside a match. */
function target(insideMatch: boolean, editable = false) {
  const seen: string[] = [];
  return {
    seen,
    node: {
      isContentEditable: editable,
      closest: (selector: string) => {
        seen.push(selector);
        return insideMatch ? {} : null;
      },
    },
  };
}

describe("reviewKeyAction", () => {
  it("moves with j/k and the arrows", () => {
    expect(reviewKeyAction(press("j"))).toBe("next");
    expect(reviewKeyAction(press("ArrowDown"))).toBe("next");
    expect(reviewKeyAction(press("k"))).toBe("prev");
    expect(reviewKeyAction(press("ArrowUp"))).toBe("prev");
  });

  it("decides one item per key, with no key for accept-all", () => {
    expect(reviewKeyAction(press("a"))).toBe("accept");
    expect(reviewKeyAction(press("r"))).toBe("reject");
    expect(
      REVIEW_SHORTCUTS.every((shortcut) => !shortcut.label.toLowerCase().includes("accept all")),
    ).toBe(true);
  });

  it("undoes with u and Ctrl/Cmd+Z, expands with Enter, lists with ?", () => {
    expect(reviewKeyAction(press("u"))).toBe("undo");
    expect(reviewKeyAction(press("z", { ctrlKey: true }))).toBe("undo");
    expect(reviewKeyAction(press("z", { metaKey: true }))).toBe("undo");
    expect(reviewKeyAction(press("Enter"))).toBe("toggle");
    expect(reviewKeyAction(press("?"))).toBe("help");
  });

  it("leaves modified keys and unknown keys to the browser", () => {
    expect(reviewKeyAction(press("a", { ctrlKey: true }))).toBeNull();
    expect(reviewKeyAction(press("a", { metaKey: true }))).toBeNull();
    expect(reviewKeyAction(press("z", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(reviewKeyAction(press("x"))).toBeNull();
    expect(reviewKeyAction(press("A"))).toBeNull();
  });
});

describe("reviewKeyAllowed", () => {
  it("fires on plain rows and outside any element", () => {
    expect(reviewKeyAllowed(null)).toBe(true);
    expect(reviewKeyAllowed(undefined)).toBe(true);
    expect(reviewKeyAllowed("row")).toBe(true);
    expect(reviewKeyAllowed(target(false).node)).toBe(true);
  });

  it("rests while typing in inputs, editable text, dialogs, or menus", () => {
    expect(reviewKeyAllowed(target(true).node)).toBe(false);
    expect(reviewKeyAllowed(target(false, true).node)).toBe(false);
  });

  it("guards the typing surfaces by selector", () => {
    const fake = target(false);
    reviewKeyAllowed(fake.node);
    const selector = fake.seen.join(" ");
    expect(selector).toContain("input");
    expect(selector).toContain("textarea");
    expect(selector).toContain('[role="dialog"]');
  });
});

describe("reviewKeyNativeEnter", () => {
  it("leaves Enter to buttons and links", () => {
    expect(reviewKeyNativeEnter(target(true).node)).toBe(true);
    expect(reviewKeyNativeEnter(target(false).node)).toBe(false);
    expect(reviewKeyNativeEnter(null)).toBe(false);
  });
});

describe("moveReviewFocus", () => {
  it("clamps moves into the list and reads an empty list as no focus", () => {
    expect(moveReviewFocus(0, 0, 1)).toBe(-1);
    expect(moveReviewFocus(3, 0, -1)).toBe(0);
    expect(moveReviewFocus(3, 2, 1)).toBe(2);
    expect(moveReviewFocus(3, 1, 1)).toBe(2);
    expect(moveReviewFocus(3, 1, -1)).toBe(0);
  });
});

describe("REVIEW_SHORTCUTS", () => {
  it("names every shortcut the board answers to", () => {
    expect(REVIEW_SHORTCUTS).toHaveLength(7);
    for (const shortcut of REVIEW_SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.label.length).toBeGreaterThan(0);
    }
    const keys = REVIEW_SHORTCUTS.flatMap((shortcut) => shortcut.keys);
    for (const key of ["j", "k", "a", "r", "u", "Enter", "?"]) {
      expect(keys).toContain(key);
    }
  });
});
