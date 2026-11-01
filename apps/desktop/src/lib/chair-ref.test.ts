import { describe, expect, it } from "vitest";
import {
  acceptsChairRef,
  decodeChairRefs,
  encodeChairRefs,
  pressStartsDrag,
  readChairRefs,
  writeChairRefs,
  type ChairRef,
} from "./chair-ref";

const ONE: ChairRef = { kind: "asset", id: "A001_C004.mov", label: "A001_C004.mov" };
const TWO: ChairRef = { kind: "asset", id: "dialogue.wav", label: "dialogue.wav" };

function stubTransfer(data: Record<string, string> = {}) {
  return {
    store: { ...data },
    effectAllowed: "none",
    get types() {
      return Object.keys(this.store);
    },
    setData(type: string, value: string) {
      this.store[type] = value;
    },
    getData(type: string) {
      return this.store[type] ?? "";
    },
  };
}

describe("pressStartsDrag", () => {
  it("drags on a press when the card is selected and draggable", () => {
    expect(pressStartsDrag({ selected: true, draggable: true })).toBe(true);
  });

  it("marquees on a press when the card is not selected", () => {
    expect(pressStartsDrag({ selected: false, draggable: true })).toBe(false);
  });

  it("marquees on a press when the card cannot drag (pieces)", () => {
    expect(pressStartsDrag({ selected: true, draggable: false })).toBe(false);
    expect(pressStartsDrag({ selected: false, draggable: false })).toBe(false);
  });
});

describe("chair ref payload", () => {
  it("writes one ref as a bare object", () => {
    expect(encodeChairRefs([ONE])).toBe(JSON.stringify(ONE));
  });

  it("writes a group as an array", () => {
    expect(encodeChairRefs([ONE, TWO])).toBe(JSON.stringify([ONE, TWO]));
  });

  it("round-trips a single drag from shelf to prompt", () => {
    expect(decodeChairRefs(encodeChairRefs([ONE]))).toEqual([ONE]);
  });

  it("round-trips a group drag from shelf to prompt", () => {
    expect(decodeChairRefs(encodeChairRefs([ONE, TWO]))).toEqual([ONE, TWO]);
  });

  it("drops malformed entries instead of failing the drop", () => {
    const raw = JSON.stringify([
      ONE,
      { kind: "asset", id: "", label: "empty id" },
      { kind: "clip", id: "c1", label: "unknown kind" },
      { kind: "asset", id: "no-label" },
      null,
    ]);
    expect(decodeChairRefs(raw)).toEqual([ONE]);
  });

  it("reads nothing from garbage, empty, or missing payloads", () => {
    expect(decodeChairRefs("{nope")).toEqual([]);
    expect(decodeChairRefs("")).toEqual([]);
    expect(decodeChairRefs(null)).toEqual([]);
    expect(decodeChairRefs(undefined)).toEqual([]);
  });
});

describe("chair ref transfer", () => {
  it("stamps a copy-allowed payload the prompt accepts and reads", () => {
    const transfer = stubTransfer();
    writeChairRefs(transfer, [ONE, TWO]);

    expect(transfer.effectAllowed).toBe("copy");
    expect(acceptsChairRef(transfer)).toBe(true);
    expect(readChairRefs(transfer)).toEqual([ONE, TWO]);
  });

  it("ignores drags without the chair ref type", () => {
    const transfer = stubTransfer({ "text/plain": "hello" });

    expect(acceptsChairRef(transfer)).toBe(false);
    expect(readChairRefs(transfer)).toEqual([]);
  });
});
