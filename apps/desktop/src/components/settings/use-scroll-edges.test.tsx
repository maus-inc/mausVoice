// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useScrollEdges, type ScrollEdges } from "./use-scroll-edges";

/**
 * A scroll container with a fixed geometry.
 *
 * jsdom does no layout, so every element reports zero for `scrollHeight` and
 * `clientHeight`. Defining them is the whole fixture: the hook only ever reads
 * those three numbers and listens for changes.
 */
const makeContainer = (height: number, view: number) => {
  const node = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(node, "scrollHeight", { get: () => height });
  Object.defineProperty(node, "clientHeight", { get: () => view });
  Object.defineProperty(node, "scrollTop", {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
    },
  });
  return node as HTMLDivElement;
};

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

const render = (node: HTMLElement | null, active = true) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const seen: ScrollEdges[] = [];
  const Probe = () => {
    const edges = useScrollEdges(node, active);
    seen.push(edges);
    return null;
  };
  act(() => root.render(<Probe />));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return () => seen[seen.length - 1];
};

it("reports which edges are hiding content", () => {
  const node = makeContainer(500, 200);
  const edges = render(node);
  expect(edges()).toEqual({ top: false, bottom: true });

  act(() => {
    node.scrollTop = 150;
    node.dispatchEvent(new Event("scroll"));
  });
  expect(edges()).toEqual({ top: true, bottom: true });

  act(() => {
    node.scrollTop = 300;
    node.dispatchEvent(new Event("scroll"));
  });
  expect(edges()).toEqual({ top: true, bottom: false });
});

it("reports nothing when the content fits", () => {
  // A dialog that fits must not get a fade: a permanent gradient over the last
  // line dims copy that is fully visible.
  const edges = render(makeContainer(200, 200));
  expect(edges()).toEqual({ top: false, bottom: false });
});

it("tolerates sub-pixel remainders at the bottom", () => {
  // Fractional layout heights mean "scrolled to the end" can be off by a
  // hair. Without the slack the fade stays on over content that is not hidden.
  const node = makeContainer(200.4, 200);
  const edges = render(node);
  expect(edges()).toEqual({ top: false, bottom: false });
});

it("re-measures when the container changes size without a scroll", () => {
  // The window resizing, or a section expanding below the fold, changes what is
  // hidden without any scroll event. Sonner is not the only thing that can grow
  // the content: the keep-ready section expands under its switch.
  //
  // The hook is not the thing under test here -- whether the ResizeObserver
  // fires is the browser's job, and jsdom has no layout engine to make it. What
  // is testable is that the hook subscribed to the element at all, because a
  // missing `observe` is the failure this guards: the fade would then only
  // update on scroll and would go stale the moment the section expanded.
  const node = makeContainer(200, 200);
  const observed: Element[] = [];
  const OriginalObserver = globalThis.ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(_callback: () => void) {}
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  try {
    render(node as HTMLDivElement);
    expect(observed).toContain(node);
  } finally {
    vi.stubGlobal("ResizeObserver", OriginalObserver);
  }
});

it("clears the edges when it goes inactive with a fade showing", () => {
  // The dialog keeps the hook mounted across close, and closing it removes the
  // box that was measured. Leaving the last measurement in place would keep a
  // fade switched on over the next open before anything had been measured --
  // the assertion has to start from a non-empty state, or it only re-tests the
  // initial value and passes without the reset.
  const node = makeContainer(500, 200);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const seen: ScrollEdges[] = [];
  const Probe = ({ active }: { active: boolean }) => {
    seen.push(useScrollEdges(node, active));
    return null;
  };
  act(() => root.render(<Probe active />));
  expect(seen[seen.length - 1]).toEqual({ top: false, bottom: true });

  act(() => root.render(<Probe active={false} />));
  expect(seen[seen.length - 1]).toEqual({ top: false, bottom: false });

  act(() => root.unmount());
  container.remove();
});
