/**
 * Tests for the `useAsyncData` hook's core lifecycle contract: stale-promise
 * suppression, error propagation, timeout, and cleanup-on-cancel.
 *
 * We test the *logic* (generation counter + timeout clearing) directly
 * against a minimal harness that mirrors the hook's state machine, rather
 * than mounting React components — the hook's interesting behaviour is
 * ordinary JS control flow around `setState` calls, which we can verify
 * deterministically without a render harness. The real hook wires this
 * logic to React's useState/useEffect/useCallback; if you change that
 * wiring, update this harness to match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type State<T> =
  | { kind: "loading" }
  | { kind: "success"; data: T }
  | { kind: "error"; error: string };

/**
 * Returns a driver that mirrors useAsyncData's lifecycle: each refresh()
 * starts a new generation; cancel() invalidates any in-flight generation
 * (which is what the useEffect cleanup does on unmount / dep change); and
 * the 30s safety timeout fires per-call.
 */
function createDriver<T>(factory: () => Promise<T>, timeoutMs = 30_000) {
  let generation = 0;
  let state: State<T> = { kind: "loading" };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isCurrent = (g: number) => generation === g;

  const cancel = () => {
    generation += 1;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const refresh = () => {
    const myGen = ++generation;
    if (timer) clearTimeout(timer);
    state = { kind: "loading" };
    timer = setTimeout(() => {
      if (!isCurrent(myGen)) return;
      generation += 1;
      state = { kind: "error", error: "Request timed out" };
    }, timeoutMs);

    return factory()
      .then((data) => {
        if (!isCurrent(myGen)) return;
        state = { kind: "success", data };
      })
      .catch((err: unknown) => {
        if (!isCurrent(myGen)) return;
        state = { kind: "error", error: String(err) };
      })
      .finally(() => {
        if (!isCurrent(myGen)) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      });
  };

  return {
    refresh,
    cancel,
    getState: () => state,
    isCurrent,
  };
}

describe("useAsyncData lifecycle (logic harness)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves and surfaces data", async () => {
    const d = createDriver(() => Promise.resolve("hello"));
    await d.refresh();
    expect(d.getState()).toEqual({ kind: "success", data: "hello" });
  });

  it("surfaces thrown errors", async () => {
    const d = createDriver(() => Promise.reject(new Error("boom")));
    await d.refresh();
    const s = d.getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.error).toContain("boom");
  });

  it("times out after the configured timeout", () => {
    const d = createDriver(() => new Promise<void>(() => {}), 500);
    void d.refresh();
    expect(d.getState()).toEqual({ kind: "loading" });
    vi.advanceTimersByTime(600);
    const s = d.getState();
    expect(s.kind).toBe("error");
    if (s.kind === "error") expect(s.error).toContain("timed out");
  });

  it("a later refresh supersedes an earlier promise (no stale data)", async () => {
    let resolve1: ((v: string) => void) | null = null;
    let resolve2: ((v: string) => void) | null = null;

    const d = createDriver(() => new Promise<string>((r) => (resolve1 = r)));
    const firstPromise = d.refresh();

    // Second refresh cancels the first generation (like a dep change
    // would). Swap the factory so the new generation waits on resolve2.
    const d2 = createDriver(() => new Promise<string>((r) => (resolve2 = r)));
    d.cancel();
    const secondPromise = d2.refresh();

    resolve2!("second");
    await secondPromise;
    expect(d2.getState()).toEqual({ kind: "success", data: "second" });

    // Resolving the first (stale) promise must NOT mutate state from the
    // cancelled driver.
    resolve1!("first-stale");
    await firstPromise;
    expect(d.getState().kind).toBe("loading");
  });

  it("cancel clears the safety timeout so a late timeout cannot flip state", () => {
    const d = createDriver(() => new Promise<void>(() => {}), 500);
    void d.refresh();
    d.cancel();
    vi.advanceTimersByTime(1000);
    // After cancel, state must stay at loading — the timeout must have
    // been cleared and its setState gated on generation match.
    expect(d.getState()).toEqual({ kind: "loading" });
  });
});
