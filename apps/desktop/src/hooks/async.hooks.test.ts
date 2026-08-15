/**
 * Tests for the `useAsyncData` hook's core lifecycle contract: stale-promise
 * suppression, error propagation, timeout, and cleanup-on-cancel.
 *
 * These exercise the real `AsyncDataController` the hook uses — not a
 * reimplementation. jsdom is intentionally avoided (it previously tripped
 * Socket's obfuscated-code scanner); the React wrapper is a thin
 * useState/useEffect binding around this controller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncDataController, type AsyncDataSink } from "./async.hooks";

type State<T> =
  | { kind: "loading" }
  | { kind: "success"; data: T }
  | { kind: "error"; error: string };

function createController<T>(timeoutMs = 30_000) {
  let loading = true;
  let error = "";
  let data: T | null = null;
  const sink: AsyncDataSink<T> = {
    setLoading: (value) => {
      loading = value;
    },
    setError: (value) => {
      error = value;
    },
    setData: (value) => {
      data = value;
    },
  };
  const controller = new AsyncDataController(sink, timeoutMs);
  return {
    controller,
    getState: (): State<T> => {
      if (loading) return { kind: "loading" };
      if (error) return { kind: "error", error };
      return { kind: "success", data: data as T };
    },
  };
}

describe("useAsyncData lifecycle (AsyncDataController)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves and surfaces data", async () => {
    const { controller, getState } = createController<string>();
    await controller.run(() => Promise.resolve("hello"));
    expect(getState()).toEqual({ kind: "success", data: "hello" });
  });

  it("surfaces thrown errors", async () => {
    const { controller, getState } = createController<string>();
    await controller.run(() => Promise.reject(new Error("boom")));
    const s = getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.error).toContain("boom");
  });

  it("times out after the configured timeout", () => {
    const { controller, getState } = createController<void>(500);
    void controller.run(() => new Promise<void>(() => {}));
    expect(getState()).toEqual({ kind: "loading" });
    vi.advanceTimersByTime(600);
    const s = getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.error).toContain("timed out");
  });

  it("a later run supersedes an earlier promise (no stale data)", async () => {
    let resolve1: ((v: string) => void) | null = null;
    let resolve2: ((v: string) => void) | null = null;

    const { controller, getState } = createController<string>();
    const first = controller.run(
      () => new Promise<string>((r) => (resolve1 = r)),
    );
    const second = controller.run(
      () => new Promise<string>((r) => (resolve2 = r)),
    );

    resolve2!("second");
    await second;
    expect(getState()).toEqual({ kind: "success", data: "second" });

    resolve1!("first-stale");
    await first;
    expect(getState()).toEqual({ kind: "success", data: "second" });
  });

  it("cancel clears the safety timeout so a late timeout cannot flip state", () => {
    const { controller, getState } = createController<void>(500);
    void controller.run(() => new Promise<void>(() => {}));
    controller.cancelInFlight();
    vi.advanceTimersByTime(1000);
    expect(getState()).toEqual({ kind: "loading" });
  });
});
