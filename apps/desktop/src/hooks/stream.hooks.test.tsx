// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Observable, Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamWithSideEffects } from "./stream.hooks";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("stream effect ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  let mounted: boolean;
  const success = vi.fn();
  const failure = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });
  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("never subscribes a builder that resolves after replacement", async () => {
    const first = deferred<Observable<string>>();
    const second = new Subject<string>();
    const oldSubscribed = vi.fn();
    const old = new Observable<string>((observer) => {
      oldSubscribed();
      observer.next("old");
    });
    const Probe = ({ index }: { index: number }) => {
      useStreamWithSideEffects({
        builder: () => (index === 0 ? first.promise : second),
        dependencies: [index],
        onSuccess: success,
        onError: failure,
      });
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    await act(async () => first.resolve(old));
    expect(oldSubscribed).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    await act(async () => second.next("new"));
    expect(success).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("ignores a builder rejection after replacement", async () => {
    const first = deferred<Observable<string>>();
    const second = new Subject<string>();
    const Probe = ({ index }: { index: number }) => {
      useStreamWithSideEffects({
        builder: () => (index === 0 ? first.promise : second),
        dependencies: [index],
        onSuccess: success,
        onError: failure,
      });
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    await act(async () => first.reject(new Error("old builder failed")));
    expect(failure).not.toHaveBeenCalled();
    await act(async () => second.next("new"));
    expect(success).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("does not deliver an old value to the new dependency owner", async () => {
    const first = new Subject<string>();
    const second = new Subject<string>();
    const Probe = ({ index }: { index: number }) => {
      useStreamWithSideEffects({
        builder: () => (index === 0 ? first : second),
        dependencies: [index],
        onSuccess: (value) => success(index, value),
        onError: failure,
      });
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => {
      first.next("old");
      root.render(createElement(Probe, { index: 1 }));
    });
    expect(success).not.toHaveBeenCalledWith(1, "old");
    await act(async () => second.next("new"));
    expect(success).toHaveBeenCalledWith(1, "new");
  });

  it("unsubscribes a previous live stream when dependencies change", async () => {
    const first = new Subject<string>();
    const second = new Subject<string>();
    const Probe = ({ index }: { index: number }) => {
      useStreamWithSideEffects({
        builder: () => (index === 0 ? first : second),
        dependencies: [index],
        onSuccess: success,
        onError: failure,
      });
      return null;
    };
    await act(async () => root.render(createElement(Probe, { index: 0 })));
    await act(async () => first.next("first"));
    await act(async () => root.render(createElement(Probe, { index: 1 })));
    expect(first.observed).toBe(false);
    await act(async () => {
      first.next("stale");
      second.next("second");
    });
    expect(success.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("never subscribes after unmount", async () => {
    const pending = deferred<Observable<string>>();
    const subscribed = vi.fn();
    const Probe = () => {
      useStreamWithSideEffects({
        builder: () => pending.promise,
        dependencies: [],
        onSuccess: success,
        onError: failure,
      });
      return null;
    };
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      root.unmount();
      mounted = false;
    });
    await act(async () =>
      pending.resolve(
        new Observable(() => {
          subscribed();
        }),
      ),
    );
    expect(subscribed).not.toHaveBeenCalled();
  });
});
