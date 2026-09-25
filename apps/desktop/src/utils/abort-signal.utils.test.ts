import { describe, expect, it, vi } from "vitest";

import { combineAbortSignals, withAbortSignal } from "./abort-signal.utils";

describe("combineAbortSignals", () => {
  it("returns the only signal when one is missing", () => {
    const signal = new AbortController().signal;
    expect(combineAbortSignals(signal, undefined)).toBe(signal);
    expect(combineAbortSignals(null, signal)).toBe(signal);
    expect(combineAbortSignals(null, undefined)).toBeUndefined();
  });

  it.each([
    ["AbortSignal.any", false],
    ["manual linking", true],
  ])("aborts when either input aborts (%s)", (_label, hideAny) => {
    const original = AbortSignal.any;
    if (hideAny) {
      Object.defineProperty(AbortSignal, "any", {
        value: undefined,
        configurable: true,
      });
    }
    try {
      const first = new AbortController();
      const second = new AbortController();
      const combined = combineAbortSignals(first.signal, second.signal);
      expect(combined?.aborted).toBe(false);
      second.abort("stop");
      expect(combined?.aborted).toBe(true);
      expect(combined?.reason).toBe("stop");

      const early = new AbortController();
      early.abort("early");
      expect(
        combineAbortSignals(early.signal, new AbortController().signal)?.reason,
      ).toBe("early");
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("withAbortSignal", () => {
  it("returns the fetch unchanged without a signal", () => {
    const base = vi.fn<typeof fetch>();
    expect(withAbortSignal(base, undefined)).toBe(base);
  });

  it("keeps the request's own signal and adds the caller's", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(""));
    const caller = new AbortController();
    const sdk = new AbortController();

    await withAbortSignal(base, caller.signal)("https://x.test", {
      method: "POST",
      signal: sdk.signal,
    });

    const init = base.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    sdk.abort();
    expect(init?.signal?.aborted).toBe(true);

    await withAbortSignal(base, caller.signal)("https://x.test");
    const second = base.mock.calls[1][1];
    caller.abort();
    expect(second?.signal?.aborted).toBe(true);
  });
});
