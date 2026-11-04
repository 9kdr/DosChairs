/** Scope enforcement: fills and text are measured from markup, then gated by flags. */
import { describe, expect, it } from "vitest";
import {
  coverageError,
  describeCovers,
  extractText,
  isFailureFallback,
  isTransparentBackground,
  scopeErrors,
} from "./scope.js";

const FRAME = (inner: string, rootStyle = "position:absolute;inset:0"): string =>
  `<div style="${rootStyle}">${inner}</div>`;

describe("isTransparentBackground", () => {
  it("lets footage through only when truly transparent", () => {
    expect(isTransparentBackground("transparent")).toBe(true);
    expect(isTransparentBackground("none")).toBe(true);
    expect(isTransparentBackground("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparentBackground("#101018")).toBe(false);
    expect(isTransparentBackground("radial-gradient(circle, #000 50%, transparent 51%)")).toBe(false);
  });
});

describe("describeCovers", () => {
  it("flags a root with an opaque background", () => {
    const covers = describeCovers(FRAME("<span/>", "position:absolute;inset:0;background:#f1ebdd"));
    expect(covers.length).toBe(1);
    expect(covers[0]).toContain("root");
  });

  it("flags an inset-0 child fill but not a transparent root", () => {
    const covers = describeCovers(
      FRAME('<div style="position:absolute;inset:0;background:#101018"><span/></div>'),
    );
    expect(covers).toEqual([expect.stringContaining("covers the frame")]);
  });

  it("ignores transparent fills, partial fills, and canvases", () => {
    expect(describeCovers(FRAME("<span/>", "position:absolute;inset:0;background:transparent"))).toEqual([]);
    expect(
      describeCovers(FRAME('<div style="position:absolute;left:10px;background:#101018"><span/></div>')),
    ).toEqual([]);
    expect(describeCovers(`<div><canvas data-uniforms="{}"></canvas></div>`)).toEqual([]);
  });
});

describe("extractText", () => {
  it("reads visible words and ignores markup", () => {
    expect(extractText(FRAME("<span>Hello&nbsp;World</span>"))).toBe("Hello World");
    expect(extractText(FRAME("<span> </span>"))).toBe("");
    expect(extractText(FRAME('<span data-x="1">x</span>'))).toBe("x");
  });
});

describe("scopeErrors", () => {
  const flags = { wantsBackground: false, wantsText: false };
  it("rejects an opaque unasked frame and unasked text", () => {
    const errors = scopeErrors(["root <div> fills the frame (background: #f1ebdd)"], "Hello", flags);
    expect(errors.length).toBe(2);
    expect(errors.join(" ")).toContain("no background");
    expect(errors.join(" ")).toContain("no text");
  });

  it("passes asked-for fills and text, and stays silent without flags", () => {
    expect(scopeErrors(["root fill"], "", { wantsBackground: true, wantsText: false })).toEqual([]);
    expect(scopeErrors([], "Hello", { wantsBackground: false, wantsText: true })).toEqual([]);
    expect(scopeErrors(["root fill"], "Hello", null)).toEqual([]);
    expect(scopeErrors([], "", flags)).toEqual([]);
  });

  it("rejects a failure fallback even when text was asked for", () => {
    const text = "WebGL2 unavailable or shader failed to compile";
    const errors = scopeErrors([], text, { wantsBackground: true, wantsText: true });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("failure fallback");
  });

  it("hands the model the GL log with the fallback error", () => {
    const errors = scopeErrors([], "shader failed to compile", flags, "ERROR: 0:65 dimension mismatch");
    expect(errors.join(" ")).toContain("ERROR: 0:65 dimension mismatch");
    expect(errors.join(" ")).toContain("explicit constructor");
  });
});

describe("isFailureFallback", () => {
  it("spots kit and host failure boxes, not effect titles", () => {
    expect(isFailureFallback("WebGL2 unavailable or shader failed to compile")).toBe(true);
    expect(isFailureFallback("fragment shader: ERROR: failed to compile")).toBe(true);
    expect(isFailureFallback("Something went wrong rendering this title")).toBe(true);
    expect(isFailureFallback("Liquid Boxes")).toBe(false);
    expect(isFailureFallback("")).toBe(false);
  });
});

describe("coverageError", () => {
  it("rejects wide visible paint unless a background was asked for", () => {
    const error = coverageError(1, false);
    expect(error).not.toBeNull();
    expect(error!).toContain("100%");
    expect(error!).toContain("premultiplied");
    expect(coverageError(0.41, false)).not.toBeNull();
  });

  it("passes narrow paint, asked-for backgrounds, and unreadable canvases", () => {
    expect(coverageError(0.4, false)).toBeNull();
    expect(coverageError(0.058, false)).toBeNull();
    expect(coverageError(1, true)).toBeNull();
    expect(coverageError(null, false)).toBeNull();
  });
});
