import { describe, expect, it } from "vitest";

import {
  readArguments,
  readBoolean,
  readBoundedCount,
  readCoordinateArray,
  readNumber,
  readNumberArray,
  readOptionalBoundedNumber,
  readPoint,
  readSecondsAsMs,
  readString,
  readStringArray,
} from "./argument-readers";

/**
 * The readers are the only place a provider's arguments turn into something the
 * vocabulary can hold, and they were previously covered only indirectly through
 * the two adapter suites. Each test here pins one rule the adapters rely on:
 * a missing field never becomes an invented default, because a defaulted
 * coordinate is a real click at the corner of the screen.
 */
describe("readArguments", () => {
  it("reads a plain object and refuses anything else", () => {
    expect(readArguments({ x: 1 })).toEqual({ x: 1 });
    expect(readArguments([1, 2])).toEqual({});
    expect(readArguments("x")).toEqual({});
    expect(readArguments(null)).toEqual({});
  });
});

describe("readNumber", () => {
  it("reads a finite number", () => {
    expect(readNumber({ a: 12 }, "a")).toBe(12);
    expect(readNumber({ a: -3.5 }, "a")).toBe(-3.5);
  });

  it("refuses a value that is not a number", () => {
    expect(readNumber({ a: "12" }, "a")).toBeUndefined();
    expect(readNumber({ a: true }, "a")).toBeUndefined();
    expect(readNumber({}, "a")).toBeUndefined();
  });

  it("refuses a number that JSON.parse turned into Infinity", () => {
    // `1e999` parses to Infinity rather than throwing, so a model can put it in
    // a coordinate field. Reaching the native layer with Infinity is a click at
    // an undefined place, so the finite check is the load-bearing part.
    const parsed = JSON.parse('{"x": 1e999}') as { x: number };
    expect(parsed.x).toBe(Infinity);
    expect(readNumber(parsed, "x")).toBeUndefined();
  });

  it("refuses NaN", () => {
    expect(readNumber({ a: Number.NaN }, "a")).toBeUndefined();
  });
});

describe("readString", () => {
  it("reads a string and refuses a non-string", () => {
    expect(readString({ a: "hi" }, "a")).toBe("hi");
    expect(readString({ a: 7 }, "a")).toBeUndefined();
    expect(readString({}, "a")).toBeUndefined();
  });

  it("passes an empty string through, and every caller refuses it downstream", () => {
    // An empty string is deliberately not blanked here. Each caller either looks
    // the value up in a set, so `""` misses and becomes `unsupported`, or hands
    // it to the key parser, which refuses it with a named error. Blanking it at
    // the reader would turn a named refusal into a silent no-op.
    expect(readString({ a: "" }, "a")).toBe("");
  });
});

describe("readBoolean", () => {
  it("reads only a real boolean", () => {
    expect(readBoolean({ a: true }, "a")).toBe(true);
    expect(readBoolean({ a: false }, "a")).toBe(false);
    expect(readBoolean({ a: "true" }, "a")).toBeUndefined();
    expect(readBoolean({}, "a")).toBeUndefined();
  });
});

describe("readBoundedCount", () => {
  it("reads a whole number inside the range", () => {
    expect(readBoundedCount({ a: 3 }, "a", 1, 10)).toBe(3);
    expect(readBoundedCount({ a: 1 }, "a", 1, 10)).toBe(1);
    expect(readBoundedCount({ a: 10 }, "a", 1, 10)).toBe(10);
  });

  it("refuses anything outside the range rather than clamping it", () => {
    expect(readBoundedCount({ a: 0 }, "a", 1, 10)).toBeUndefined();
    expect(readBoundedCount({ a: 11 }, "a", 1, 10)).toBeUndefined();
    expect(readBoundedCount({ a: 2.5 }, "a", 1, 10)).toBeUndefined();
    expect(readBoundedCount({ a: -1 }, "a", 1, 10)).toBeUndefined();
  });

  it("cannot tell an absent field from an unreadable one", () => {
    // This is the documented limitation: both answer `undefined`, so a caller
    // that needs the difference must use `readOptionalBoundedNumber`.
    expect(readBoundedCount({}, "a", 1, 10)).toBeUndefined();
  });
});

describe("readOptionalBoundedNumber", () => {
  it("reports absent, unreadable and in-range as three different answers", () => {
    expect(readOptionalBoundedNumber({}, "a", 0, 999)).toBeUndefined();
    expect(readOptionalBoundedNumber({ a: 5 }, "a", 0, 999)).toBe(5);
    expect(readOptionalBoundedNumber({ a: "5" }, "a", 0, 999)).toBeNull();
    expect(readOptionalBoundedNumber({ a: 1000 }, "a", 0, 999)).toBeNull();
    expect(readOptionalBoundedNumber({ a: -100 }, "a", 0, 999)).toBeNull();
  });

  it("lets the scroll magnitude reach the adapter, which defaults only when absent", () => {
    expect(readOptionalBoundedNumber({}, "a", 0, 999)).toBeUndefined();
    expect(readOptionalBoundedNumber({ a: -1 }, "a", 0, 999)).toBeNull();
  });
});

describe("readSecondsAsMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(readSecondsAsMs({ a: 2 }, "a", 300)).toBe(2000);
    expect(readSecondsAsMs({ a: 0 }, "a", 300)).toBe(0);
  });

  it("clamps to the ceiling the provider documents", () => {
    expect(readSecondsAsMs({ a: 10_000 }, "a", 300)).toBe(300_000);
  });

  it("refuses a negative duration rather than waiting backwards", () => {
    expect(readSecondsAsMs({ a: -1 }, "a", 300)).toBeUndefined();
  });

  it("refuses a value that is not a number", () => {
    expect(readSecondsAsMs({ a: "soon" }, "a", 300)).toBeUndefined();
    expect(readSecondsAsMs({}, "a", 300)).toBeUndefined();
  });
});

describe("readStringArray", () => {
  it("reads a non-empty array of non-empty strings", () => {
    expect(readStringArray({ a: ["x", "y"] }, "a")).toEqual(["x", "y"]);
  });

  it("refuses an empty array or one holding a non-string", () => {
    expect(readStringArray({ a: [] }, "a")).toBeUndefined();
    expect(readStringArray({ a: ["x", 1] }, "a")).toBeUndefined();
    expect(readStringArray({ a: "x" }, "a")).toBeUndefined();
  });
});

describe("readNumberArray", () => {
  it("reads an array of finite numbers and accepts an empty one", () => {
    expect(readNumberArray({ a: [1, 2] }, "a")).toEqual([1, 2]);
    expect(readNumberArray({ a: [] }, "a")).toEqual([]);
  });

  it("refuses a non-number element", () => {
    expect(readNumberArray({ a: [1, "x"] }, "a")).toBeUndefined();
    expect(readNumberArray({ a: [Number.NaN] }, "a")).toBeUndefined();
  });
});

describe("readCoordinateArray", () => {
  it("reads one point out of a two-number pair", () => {
    expect(readCoordinateArray({ a: [1, 2] }, "a")).toEqual({ x: 1, y: 2 });
  });

  it("refuses an empty array, which `readNumberArray` allows", () => {
    expect(readCoordinateArray({ a: [] }, "a")).toBeUndefined();
  });

  it("refuses a pair of the wrong arity", () => {
    expect(readCoordinateArray({ a: [1, 2, 3] }, "a")).toBeUndefined();
    expect(readCoordinateArray({ a: [1] }, "a")).toBeUndefined();
    expect(readCoordinateArray({ a: [1, "x"] }, "a")).toBeUndefined();
  });
});

describe("readPoint", () => {
  const NAMED: { xKey: "x"; yKey: "y"; tupleKeys: ["coordinate"] } = {
    xKey: "x",
    yKey: "y",
    tupleKeys: ["coordinate"],
  };

  it("prefers the declared tuple spelling", () => {
    expect(readPoint({ coordinate: [5, 6], x: 1, y: 2 }, NAMED)).toEqual({
      x: 5,
      y: 6,
    });
  });

  it("falls back to the declared named spelling", () => {
    expect(readPoint({ x: 1, y: 2 }, NAMED)).toEqual({ x: 1, y: 2 });
  });

  it("answers undefined when only one half is present, never a defaulted point", () => {
    // A missing half must not become 0, which is a real click at the top-left
    // corner of the display.
    expect(readPoint({ x: 1 }, NAMED)).toBeUndefined();
    expect(readPoint({ y: 2 }, NAMED)).toBeUndefined();
    expect(readPoint({}, NAMED)).toBeUndefined();
  });

  it("refuses a tuple of the wrong length", () => {
    expect(readPoint({ coordinate: [1, 2, 3] }, NAMED)).toBeUndefined();
    expect(readPoint({ coordinate: 1 }, NAMED)).toBeUndefined();
  });
});