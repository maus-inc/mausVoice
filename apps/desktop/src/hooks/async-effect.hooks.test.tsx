// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => logs }));
import { useAsyncEffect } from "./async.hooks";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("useAsyncEffect lifetime", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("serializes a replacement behind the old asynchronous cleanup", async () => {
    const first = deferred<() => void>();
    const events: string[] = [];
    const effects = [
      () => {
        events.push("start first");
        return first.promise;
      },
      async () => {
        events.push("start second");
        return () => events.push("cleanup second");
      },
    ];
    const Probe = ({ index }: { index: number }) => {
      useAsyncEffect(effects[index], [index]);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    expect(events).toEqual(["start first"]);
    await act(async () => first.resolve(() => events.push("cleanup first")));
    expect(events).toEqual(["start first", "cleanup first", "start second"]);
    await act(async () => root.unmount());
    expect(events).toEqual([
      "start first",
      "cleanup first",
      "start second",
      "cleanup second",
    ]);
  });

  it("skips a superseded queued effect and cleans the live replacement once", async () => {
    const pending = deferred<() => void>();
    const oldCleanup = vi.fn();
    const lastCleanup = vi.fn();
    const skipped = vi.fn(async () => {});
    const last = vi.fn(async () => lastCleanup);
    const effects = [() => pending.promise, skipped, last];
    const Probe = ({ index }: { index: number }) => {
      useAsyncEffect(effects[index], [index]);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    await act(async () => root.render(createElement(Probe, { index: 2 })));
    await act(async () => pending.resolve(oldCleanup));
    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(skipped).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
    expect(lastCleanup).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(lastCleanup).toHaveBeenCalledOnce();
  });

  it("reports a cleanup that throws after its effect was cancelled", async () => {
    const pending = deferred<() => void>();
    const cleanup = vi.fn(() => {
      throw new Error("late cleanup failed");
    });
    const next = vi.fn(async () => {});
    const Probe = ({ index }: { index: number }) => {
      useAsyncEffect(index === 0 ? () => pending.promise : next, [index]);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    await act(async () => pending.resolve(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(logs.warning).toHaveBeenCalled();
  });

  it("reports a rejected effect and allows later effects to run", async () => {
    const first = deferred<void>();
    const second = vi.fn(async () => {});
    const effects = [() => first.promise, second];
    const Probe = ({ index }: { index: number }) => {
      useAsyncEffect(effects[index], [index]);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    await act(async () => first.reject(new Error("effect failed")));
    expect(second).toHaveBeenCalledOnce();
    expect(logs.warning).toHaveBeenCalled();
  });

  it("reports a cleanup failure without blocking a replacement", async () => {
    const cleanup = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const second = vi.fn(async () => {});
    const effects = [async () => cleanup, second];
    const Probe = ({ index }: { index: number }) => {
      useAsyncEffect(effects[index], [index]);
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(logs.warning).toHaveBeenCalled();
  });
});
