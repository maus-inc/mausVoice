import { describe, expect, it } from "vitest";
import {
  replaceDictationHotkeys,
  replaceStyleHotkeys,
} from "./hotkey-replacement";

type WireRecord = Record<string, unknown>;

const hotkey = (
  id: string,
  actionName: string,
  keys: string[] = ["Alt"],
): WireRecord => ({
  id,
  actionName,
  keys,
});

const currentOf = (...hotkeys: WireRecord[]): Map<string, WireRecord> =>
  new Map(hotkeys.map((hotkey) => [String(hotkey.id), hotkey]));

describe("replaceStyleHotkeys", () => {
  it("replaces the whole style group and leaves other shortcuts alone", () => {
    const current = currentOf(
      hotkey("a", "switch-to-style:casual"),
      hotkey("b", "switch-to-style:formal"),
      hotkey("k", "other-action"),
    );

    const { next, hotkeys } = replaceStyleHotkeys(current, {
      prefix: "switch-to-style:",
      hotkeys: [hotkey("c", "switch-to-style:casual", ["Alt", "C"])],
      expected: [current.get("a"), current.get("b")],
    });

    expect(hotkeys).toEqual([
      hotkey("c", "switch-to-style:casual", ["Alt", "C"]),
    ]);
    expect([...next.keys()].sort()).toEqual(["c", "k"]);
    // The input map is staged, never mutated: the preview runtime commits `next`.
    expect([...current.keys()].sort()).toEqual(["a", "b", "k"]);
  });

  it("rejects a snapshot that no longer matches after another edit", () => {
    const current = currentOf(hotkey("a", "switch-to-style:casual"));

    expect(() =>
      replaceStyleHotkeys(current, {
        prefix: "switch-to-style:",
        hotkeys: [],
        expected: [],
      }),
    ).toThrow("STYLE_HOTKEYS_CHANGED");
  });

  it("rejects an empty prefix, a foreign action and a reused id", () => {
    const current = currentOf(
      hotkey("a", "switch-to-style:casual"),
      hotkey("k", "other-action"),
    );
    const expected = [current.get("a")];

    expect(() =>
      replaceStyleHotkeys(current, { prefix: "", hotkeys: [], expected }),
    ).toThrow(TypeError);
    expect(() =>
      replaceStyleHotkeys(current, {
        prefix: "switch-to-style:",
        hotkeys: [hotkey("x", "other-action")],
        expected,
      }),
    ).toThrow("Invalid or conflicting additional hotkey");
    expect(() =>
      replaceStyleHotkeys(current, {
        prefix: "switch-to-style:",
        hotkeys: [hotkey("k", "switch-to-style:formal")],
        expected,
      }),
    ).toThrow("Invalid or conflicting additional hotkey");
    expect(() =>
      replaceStyleHotkeys(current, {
        prefix: "switch-to-style:",
        hotkeys: [hotkey("y", "switch-to-style:")],
        expected,
      }),
    ).toThrow("Invalid or conflicting additional hotkey");
  });
});

describe("replaceDictationHotkeys", () => {
  const primary = hotkey("primary", "dictate", ["Control"]);
  const french = hotkey("fr", "additional-language:fr", ["Alt", "F"]);

  it("rewrites the dictate and language shortcuts in one staged map", () => {
    const current = currentOf(primary, french, hotkey("k", "other-action"));

    const next = replaceDictationHotkeys(current, {
      primary: hotkey("primary", "dictate", ["Control", "D"]),
      additional: [hotkey("de", "additional-language:de", ["Alt", "D"])],
      expected: [primary, french],
    });

    expect([...next.keys()].sort()).toEqual(["de", "k", "primary"]);
    expect(next.get("primary")).toEqual(
      hotkey("primary", "dictate", ["Control", "D"]),
    );
    expect(next.has("fr")).toBe(false);
  });

  it("keeps an extra dictate binding that travels back in additional", () => {
    const second = hotkey("secondary", "dictate", ["Alt", "D"]);
    const current = currentOf(primary, second, french);

    const next = replaceDictationHotkeys(current, {
      primary: hotkey("primary", "dictate", ["Control", "D"]),
      additional: [hotkey("secondary", "dictate", ["Alt", "D"]), french],
      expected: [primary, second, french],
    });

    expect([...next.keys()].sort()).toEqual(["fr", "primary", "secondary"]);
    expect(next.get("secondary")).toEqual(second);
  });

  it("drops a dictate binding the caller no longer lists", () => {
    const second = hotkey("secondary", "dictate", ["Alt", "D"]);
    const current = currentOf(primary, second);

    const next = replaceDictationHotkeys(current, {
      primary,
      additional: [],
      expected: [primary, second],
    });

    expect([...next.keys()]).toEqual(["primary"]);
  });

  it("rejects a primary that is not the dictate action", () => {
    const current = currentOf(primary);

    expect(() =>
      replaceDictationHotkeys(current, {
        primary: hotkey("primary", "other-action"),
        additional: [],
        expected: [primary],
      }),
    ).toThrow("Invalid dictation hotkeys");
  });

  it("rejects a primary id that belongs to another action", () => {
    const current = currentOf(primary, hotkey("k", "other-action"));

    expect(() =>
      replaceDictationHotkeys(current, {
        primary: hotkey("k", "dictate"),
        additional: [],
        expected: [primary],
      }),
    ).toThrow("Primary hotkey ID belongs to another action");
  });

  it("rejects an additional shortcut outside the language prefix", () => {
    const current = currentOf(primary);

    expect(() =>
      replaceDictationHotkeys(current, {
        primary,
        additional: [hotkey("x", "switch-to-style:casual")],
        expected: [primary],
      }),
    ).toThrow("Invalid or conflicting additional hotkey");
  });

  it("rejects a stale snapshot and an unauthenticated edit after it", () => {
    const current = currentOf(primary, french);
    const stale = [primary];

    expect(() =>
      replaceDictationHotkeys(current, {
        primary,
        additional: [],
        expected: stale,
      }),
    ).toThrow("DICTATION_HOTKEYS_CHANGED");
    expect(() =>
      replaceDictationHotkeys(current, {
        primary,
        additional: [],
        expected: "nope",
      }),
    ).toThrow(TypeError);
  });
});
