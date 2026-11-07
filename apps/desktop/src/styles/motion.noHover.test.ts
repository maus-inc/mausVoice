// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

/**
 * `readNoHover` is handed to `useSyncExternalStore` as `getSnapshot`, and React
 * requires `getSnapshot` to be free of side effects: a concurrent render can be
 * started and thrown away without ever committing, so anything `getSnapshot`
 * builds is built for a render that may never happen.
 *
 * The decidable property is *when* `matchMedia` is called. Building the
 * `MediaQueryList` means calling `matchMedia` and registering a `change`
 * listener, so an impure `getSnapshot` calls `matchMedia` during the render
 * phase. Subscribing is the legitimate place for that work, and it runs in the
 * effect phase. Counting the calls as seen from inside the render body
 * therefore separates the two, and a component whose only job is to report the
 * count is a real observation rather than a restatement of the source.
 */

type MediaQueryStub = {
  matches: boolean;
  /** Live `change` listeners on the single shared `MediaQueryList`. */
  listenerCount: number;
  callCount: number;
  fire: (matches: boolean) => void;
};

const installMatchMedia = (initialMatches = false): MediaQueryStub => {
  const stub: MediaQueryStub = {
    matches: initialMatches,
    listenerCount: 0,
    callCount: 0,
    fire: () => undefined,
  };
  const listeners = new Set<(event: { matches: boolean }) => void>();
  globalThis.matchMedia = ((query: string) => {
    stub.callCount += 1;
    return {
      get matches() {
        return stub.matches;
      },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (
        type: string,
        listener: (event: { matches: boolean }) => void,
      ) => {
        if (type === "change") {
          listeners.add(listener);
          stub.listenerCount = listeners.size;
        }
      },
      removeEventListener: (
        type: string,
        listener: (event: { matches: boolean }) => void,
      ) => {
        if (type === "change") {
          listeners.delete(listener);
          stub.listenerCount = listeners.size;
        }
      },
      dispatchEvent: () => false,
    };
  }) as unknown as typeof globalThis.matchMedia;
  stub.fire = (matches: boolean) => {
    stub.matches = matches;
    // Snapshot first: a listener that unsubscribes during dispatch would
    // otherwise mutate the set mid-iteration.
    for (const listener of Array.from(listeners)) listener({ matches });
  };
  return stub;
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  // The module keeps its `MediaQueryList` in a module-level singleton, so a
  // cached import would hand the second test a `matchMedia` stub from the
  // first. Resetting the registry gives every test a fresh module.
  vi.resetModules();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/**
 * Report what the module had done by the time the component body runs, which
 * is after the hook's `getSnapshot` and before any effect has run.
 */
const renderProbe = async (
  label: string,
  onRender?: (stub: MediaQueryStub) => void,
): Promise<{ stub: MediaQueryStub; hook: () => Promise<boolean> }> => {
  const stub = installMatchMedia();
  const { useNoHoverPointer } = await import("./motion");

  const Probe = ({ tag }: { tag: string }) => {
    const noHover = useNoHoverPointer();
    onRender?.(stub);
    return createElement("span", null, `${tag}:${noHover ? "no" : "yes"}`);
  };

  await act(async () => {
    root.render(createElement(Probe, { tag: label }));
  });
  return { stub, hook: async () => useNoHoverPointer() };
};

describe("useNoHoverPointer", () => {
  it("does not build the media query during render", async () => {
    const callsDuringRender: number[] = [];

    await renderProbe("a", (stub) => callsDuringRender.push(stub.callCount));

    // Zero, because `matchMedia` is what creates the `MediaQueryList`, and
    // creating it is a side effect. `getSnapshot` ran before the component body
    // above, so a non-zero count here is an impure `getSnapshot`.
    expect(callsDuringRender).toEqual([0]);
  });

  it("still reports a live no-hover pointer on the first render", async () => {
    // A pointer that cannot hover must be visible at rest without any change
    // event firing first. This is the case that breaks if the snapshot reads a
    // value captured before the `MediaQueryList` existed: the first `getSnapshot`
    // happens before `subscribe`, so the read has to consult the live query
    // once it has been built.
    const stub = installMatchMedia(true);
    const { useNoHoverPointer } = await import("./motion");
    const Probe = () =>
      createElement("span", null, useNoHoverPointer() ? "no-hover" : "hover");

    await act(async () => {
      root.render(createElement(Probe));
    });

    expect(stub.callCount).toBeGreaterThan(0);
    expect(container.textContent).toBe("no-hover");
  });

  it("shares one media query and one listener across every subscriber", async () => {
    const stub = installMatchMedia();
    const { useNoHoverPointer } = await import("./motion");

    const Probe = ({ tag }: { tag: string }) =>
      createElement(
        "span",
        null,
        `${tag}:${useNoHoverPointer() ? "no" : "yes"}`,
      );

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(Probe, { key: "a", tag: "a" }),
          createElement(Probe, { key: "b", tag: "b" }),
          createElement(Probe, { key: "c", tag: "c" }),
        ),
      );
    });

    // The property the module comment claims: one subscription shared by every
    // caller, rather than a hundred `useMediaQuery` calls each with a listener.
    expect(stub.listenerCount).toBe(1);
    expect(stub.callCount).toBe(1);
    expect(container.textContent).toBe("a:yesb:yesc:yes");

    await act(async () => {
      stub.fire(true);
    });
    expect(container.textContent).toBe("a:nob:noc:no");
  });

  it("assumes hover when the environment cannot answer the query", async () => {
    // Browser preview and the SSR-shaped server snapshot both land here. A
    // caller that only reveals on hover keeps its resting state, which is the
    // safe direction: an affordance stays visible rather than disappearing.
    const original = globalThis.matchMedia;
    // @ts-expect-error deliberately removing the global to model a host without it
    delete globalThis.matchMedia;
    try {
      const { useNoHoverPointer } = await import("./motion");
      const Probe = () =>
        createElement("span", null, useNoHoverPointer() ? "no-hover" : "hover");

      await act(async () => {
        root.render(createElement(Probe));
      });
      expect(container.textContent).toBe("hover");
    } finally {
      globalThis.matchMedia = original;
    }
  });
});
