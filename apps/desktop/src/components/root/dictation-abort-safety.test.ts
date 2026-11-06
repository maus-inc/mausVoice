import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorAbortRelease } from "./dictation-abort-safety";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

afterEach(() => vi.useRealTimers());

describe("microphone guidance after cancellation", () => {
  it("replaces the stop prompt and repeats while release hangs", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dismiss = vi.fn();
    const pending = deferred();
    const monitor = monitorAbortRelease({
      isCurrent: () => true,
      show,
      dismiss,
      immediately: true,
    });
    monitor.watch(pending.promise);
    expect(show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(show).toHaveBeenCalledTimes(2);
    expect(dismiss).not.toHaveBeenCalled();
    pending.resolve();
    await pending.promise;
    expect(dismiss).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("warns on rejection without dismissing or claiming release", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dismiss = vi.fn();
    const pending = deferred();
    const monitor = monitorAbortRelease({
      isCurrent: () => true,
      show,
      dismiss,
      immediately: false,
    });
    monitor.watch(pending.promise);
    pending.reject(new Error("release failed"));
    await Promise.resolve();
    expect(monitor.isFailed()).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("retries a rejected scoped discard and warns until it confirms release", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dismiss = vi.fn();
    const first = deferred();
    const late = deferred();
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error("release still pending"))
      .mockReturnValueOnce(late.promise);
    const monitor = monitorAbortRelease({
      isCurrent: () => true,
      show,
      dismiss,
      immediately: true,
      retry,
    });
    monitor.watch(first.promise);
    first.reject(new Error("release failed"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).toHaveBeenCalledTimes(2);
    // Even a duplicate failure notification must not overlap the pending retry.
    monitor.failed();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(show.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(dismiss).not.toHaveBeenCalled();
    late.resolve();
    await late.promise;
    await Promise.resolve();
    expect(monitor.isFailed()).toBe(false);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("stops retrying after a successor takes ownership", async () => {
    vi.useFakeTimers();
    let current = true;
    const retry = vi.fn().mockRejectedValue(new Error("release failed"));
    const monitor = monitorAbortRelease({
      isCurrent: () => current,
      show: vi.fn(),
      dismiss: vi.fn(),
      immediately: true,
      retry,
    });
    monitor.failed();
    current = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not warn for a fast confirmed release", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dismiss = vi.fn();
    const pending = deferred();
    const monitor = monitorAbortRelease({
      isCurrent: () => true,
      show,
      dismiss,
      immediately: false,
    });
    monitor.watch(pending.promise);
    pending.resolve();
    await pending.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(show).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not display or refresh guidance after a successor takes ownership", async () => {
    vi.useFakeTimers();
    let current = true;
    const show = vi.fn();
    const dismiss = vi.fn();
    const pending = deferred();
    const monitor = monitorAbortRelease({
      isCurrent: () => current,
      show,
      dismiss,
      immediately: true,
    });
    monitor.watch(pending.promise);
    const guard = show.mock.calls[0]![1] as () => boolean;
    current = false;
    expect(guard()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(show).toHaveBeenCalledOnce();
    monitor.failed();
    expect(show).toHaveBeenCalledOnce();
    pending.resolve();
    await pending.promise;
    expect(dismiss).not.toHaveBeenCalled();
  });
});
