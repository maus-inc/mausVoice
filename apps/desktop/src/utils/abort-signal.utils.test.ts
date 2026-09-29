import { afterEach, describe, expect, it, vi } from "vitest";

import { combineAbortSignals, withAbortSignal } from "./abort-signal.utils";

/** Counts listeners still attached to a signal, so leaks are observable. */
const liveListenerCount = (signal: AbortSignal): (() => number) => {
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  return () => add.mock.calls.length - remove.mock.calls.length;
};

const originalAny = AbortSignal.any;

/** Hides `AbortSignal.any` to force the manual linking path. */
const hideAny = (): void => {
  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
  });
};

afterEach(() => {
  Object.defineProperty(AbortSignal, "any", {
    value: originalAny,
    configurable: true,
  });
});

describe("combineAbortSignals", () => {
  it("returns the only signal when one is missing", () => {
    const signal = new AbortController().signal;
    expect(combineAbortSignals(signal, undefined)?.signal).toBe(signal);
    expect(combineAbortSignals(null, signal)?.signal).toBe(signal);
    expect(combineAbortSignals(null, undefined)).toBeUndefined();
  });

  it.each([
    ["AbortSignal.any", false],
    ["manual linking", true],
  ])("aborts when either input aborts (%s)", (_label, manual) => {
    if (manual) hideAny();
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals(first.signal, second.signal);
    expect(combined?.signal.aborted).toBe(false);
    second.abort("stop");
    expect(combined?.signal.aborted).toBe(true);
    expect(combined?.signal.reason).toBe("stop");

    const early = new AbortController();
    early.abort("early");
    expect(
      combineAbortSignals(early.signal, new AbortController().signal)?.signal
        .reason,
    ).toBe("early");
  });

  it("leaves no listener on a long-lived input once disposed", () => {
    hideAny();
    const longLived = new AbortController();
    const perRequest = new AbortController();
    const pending = liveListenerCount(longLived.signal);

    const combined = combineAbortSignals(perRequest.signal, longLived.signal);
    expect(pending()).toBe(1);

    combined?.dispose();
    expect(pending()).toBe(0);
  });

  it("detaches the other input as soon as one aborts", () => {
    hideAny();
    const first = new AbortController();
    const second = new AbortController();
    const pendingFirst = liveListenerCount(first.signal);
    const pendingSecond = liveListenerCount(second.signal);

    combineAbortSignals(first.signal, second.signal);
    expect(pendingFirst()).toBe(1);
    expect(pendingSecond()).toBe(1);

    first.abort();
    expect(pendingFirst()).toBe(0);
    expect(pendingSecond()).toBe(0);
  });

  it("never attaches a listener to an already-aborted input", () => {
    hideAny();
    const aborted = new AbortController();
    aborted.abort("early");
    const pending = liveListenerCount(aborted.signal);
    combineAbortSignals(aborted.signal, new AbortController().signal);
    expect(pending()).toBe(0);
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
    expect(init?.signal?.aborted).toBe(false);
    sdk.abort();
    expect(init?.signal?.aborted).toBe(true);

    await withAbortSignal(base, caller.signal)("https://x.test");
    const second = base.mock.calls[1][1];
    caller.abort();
    expect(second?.signal?.aborted).toBe(true);
  });

  it("detaches the caller's listeners after each request settles", async () => {
    hideAny();
    const base = vi.fn<typeof fetch>(async () => new Response(""));
    const caller = new AbortController();
    const pending = liveListenerCount(caller.signal);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withAbortSignal(base, caller.signal)("https://x.test");
    }
    // A dictation that sends ten spans must not retain thirty listeners.
    expect(pending()).toBe(0);
  });

  it("detaches the caller's listeners when the request rejects", async () => {
    hideAny();
    const base = vi.fn<typeof fetch>(async () => {
      throw new Error("network");
    });
    const caller = new AbortController();
    const pending = liveListenerCount(caller.signal);

    await expect(
      withAbortSignal(base, caller.signal)("https://x.test"),
    ).rejects.toThrow("network");
    expect(pending()).toBe(0);
  });
});
