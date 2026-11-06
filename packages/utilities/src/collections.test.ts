import { describe, expect, it } from "vitest";
import { getRec } from "./collections";

describe("getRec", () => {
  it("ignores inherited properties instead of treating them as records", () => {
    const records = Object.create({ inherited: "not a record" }) as Record<
      string,
      string
    >;
    records.own = "value";
    expect(getRec(records, "own")).toBe("value");
    expect(getRec(records, "inherited")).toBeUndefined();
    const empty: Record<string, unknown> = {};
    expect(getRec(empty, "constructor", "missing")).toBe("missing");
    expect(getRec(empty, "__proto__")).toBeUndefined();
  });

  it("preserves own values, null-prototype maps, and fallback behavior", () => {
    const records = Object.assign(Object.create(null), {
      "0": 0,
      empty: "",
      nil: null,
      missing: undefined,
    }) as Record<string, unknown>;
    expect(getRec(records, "0", "fallback")).toBe(0);
    expect(getRec(records, "empty", "fallback")).toBe("");
    expect(getRec(records, "nil", "fallback")).toBeNull();
    expect(getRec(records, "missing", "fallback")).toBe("fallback");
    expect(getRec(records, null, "fallback")).toBe("fallback");
    expect(getRec(undefined, "anything", "fallback")).toBe("fallback");
  });
});
