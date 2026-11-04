import { describe, expect, it } from "vitest";
import {
  HISTORY_SHORTCUTS,
  historyKeyAction,
  historyKeyAllowed,
  historyKeyNativeEnter,
  moveHistoryFocus,
  type HistoryKeyPress,
} from "./history-keys";

function press(key: string, modifiers: Partial<HistoryKeyPress> = {}): HistoryKeyPress {
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

describe("historyKeyAction", () => {
  it("moves with j/k and the arrows", () => {
    expect(historyKeyAction(press("j"))).toBe("next");
    expect(historyKeyAction(press("ArrowDown"))).toBe("next");
    expect(historyKeyAction(press("k"))).toBe("prev");
    expect(historyKeyAction(press("ArrowUp"))).toBe("prev");
  });

  it("undoes last with u and Ctrl/Cmd+Z, and to-here with Shift+U", () => {
    expect(historyKeyAction(press("u"))).toBe("undo");
    expect(historyKeyAction(press("z", { ctrlKey: true }))).toBe("undo");
    expect(historyKeyAction(press("z", { metaKey: true }))).toBe("undo");
    expect(historyKeyAction(press("U", { shiftKey: true }))).toBe("undoHere");
    expect(historyKeyAction(press("u", { shiftKey: true }))).toBe("undoHere");
  });

  it("still maps a/r (the card ignores them), Enter to expand, ? for help", () => {
    expect(historyKeyAction(press("a"))).toBe("accept");
    expect(historyKeyAction(press("r"))).toBe("reject");
    expect(historyKeyAction(press("Enter"))).toBe("toggle");
    expect(historyKeyAction(press("?"))).toBe("help");
  });

  it("leaves modified keys and unknown keys to the browser", () => {
    expect(historyKeyAction(press("a", { ctrlKey: true }))).toBeNull();
    expect(historyKeyAction(press("a", { metaKey: true }))).toBeNull();
    expect(historyKeyAction(press("z", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(historyKeyAction(press("x"))).toBeNull();
    expect(historyKeyAction(press("A", { shiftKey: false }))).toBeNull();
  });
});

describe("historyKeyAllowed", () => {
  it("fires on plain rows and outside any element", () => {
    expect(historyKeyAllowed(null)).toBe(true);
    expect(historyKeyAllowed(undefined)).toBe(true);
    expect(historyKeyAllowed("row")).toBe(true);
    expect(historyKeyAllowed(target(false).node)).toBe(true);
  });

  it("rests while typing in inputs, editable text, dialogs, or menus", () => {
    expect(historyKeyAllowed(target(true).node)).toBe(false);
    expect(historyKeyAllowed(target(false, true).node)).toBe(false);
  });

  it("guards the typing surfaces by selector", () => {
    const fake = target(false);
    historyKeyAllowed(fake.node);
    const selector = fake.seen.join(" ");
    expect(selector).toContain("input");
    expect(selector).toContain("textarea");
    expect(selector).toContain('[role="dialog"]');
  });
});

describe("historyKeyNativeEnter", () => {
  it("leaves Enter to buttons and links", () => {
    expect(historyKeyNativeEnter(target(true).node)).toBe(true);
    expect(historyKeyNativeEnter(target(false).node)).toBe(false);
    expect(historyKeyNativeEnter(null)).toBe(false);
  });
});

describe("moveHistoryFocus", () => {
  it("clamps moves into the list and reads an empty list as no focus", () => {
    expect(moveHistoryFocus(0, 0, 1)).toBe(-1);
    expect(moveHistoryFocus(3, 0, -1)).toBe(0);
    expect(moveHistoryFocus(3, 2, 1)).toBe(2);
    expect(moveHistoryFocus(3, 1, 1)).toBe(2);
    expect(moveHistoryFocus(3, 1, -1)).toBe(0);
  });
});

describe("HISTORY_SHORTCUTS", () => {
  it("names every shortcut the history answers to, with no accept step", () => {
    expect(HISTORY_SHORTCUTS).toHaveLength(6);
    for (const shortcut of HISTORY_SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.label.length).toBeGreaterThan(0);
    }
    const keys = HISTORY_SHORTCUTS.flatMap((shortcut) => shortcut.keys);
    for (const key of ["j", "k", "u", "Shift U", "Enter", "?"]) {
      expect(keys).toContain(key);
    }
    expect(keys).not.toContain("a");
    expect(keys).not.toContain("r");
    const labels = HISTORY_SHORTCUTS.map((shortcut) => shortcut.label).join("\n");
    expect(labels).not.toContain("Accept");
    expect(labels).not.toContain("Reject");
  });
});
