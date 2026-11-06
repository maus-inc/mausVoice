import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeDashboardMenu } from "./dashboard-menu-observer";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("dashboard menu window observer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces the initial synchronization and window events", async () => {
    let listener = () => {};
    const unlisten = vi.fn();
    const push = vi.fn(async () => {});
    const cleanup = observeDashboardMenu({
      subscribe: [
        (callback) => {
          listener = callback;
          return Promise.resolve(unlisten);
        },
      ],
      push,
      onError: vi.fn(),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    listener();
    await vi.advanceTimersByTimeAsync(49);
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(push).toHaveBeenCalledOnce();
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
    listener();
    await vi.advanceTimersByTimeAsync(50);
    expect(push).toHaveBeenCalledOnce();
  });

  it("releases successful listeners even if another registration rejects", async () => {
    const one = deferred<() => void>();
    const two = deferred<() => void>();
    const first = vi.fn();
    const second = vi.fn();
    const onError = vi.fn();
    const cleanup = observeDashboardMenu({
      subscribe: [
        () => one.promise,
        () => Promise.reject(new Error("registration failed")),
        () => two.promise,
      ],
      push: vi.fn(async () => {}),
      onError,
    });
    one.resolve(first);
    two.resolve(second);
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("immediately releases listeners that resolve after cleanup", async () => {
    const pending = deferred<() => void>();
    const release = vi.fn();
    const push = vi.fn(async () => {});
    const cleanup = observeDashboardMenu({
      subscribe: [() => pending.promise],
      push,
      onError: vi.fn(),
    });
    cleanup();
    pending.resolve(release);
    await vi.advanceTimersByTimeAsync(100);
    expect(release).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("continues cleanup if an unlisten throws", async () => {
    const release = vi.fn();
    const onError = vi.fn();
    const cleanup = observeDashboardMenu({
      subscribe: [
        () =>
          Promise.resolve(() => {
            throw new Error("unlisten failed");
          }),
        () => Promise.resolve(release),
      ],
      push: vi.fn(async () => {}),
      onError,
    });
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
