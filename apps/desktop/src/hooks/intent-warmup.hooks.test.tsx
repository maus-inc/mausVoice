// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTENT_DELAY_MS,
  ROUTE_WARMUP_DELAY_MS,
  useIntentWarmup,
} from "./intent-warmup.hooks";

// The full intent lifecycle for #301: hover intent, leave-before-timeout,
// focus intent, blur, touch exclusion, duplicate intent, unmount cleanup, and
// route-change (key) cleanup. "Navigation after prefetch reuses the warmed
// result" is covered by route-prefetch.test.ts (shared import promise).

type HookProps = { key: string; delayMs?: number; warm: () => Promise<unknown> };

/** Minimal renderHook: mounts the hook and mirrors its latest return value. */
const mountHook = (
  warm: () => Promise<unknown>,
  key: string,
  delayMs?: number,
) => {
  const holder: {
    current: ReturnType<typeof useIntentWarmup>;
  } = { current: undefined as never };
  const Probe = ({ key: k, delayMs: d, warm: w }: HookProps) => {
    holder.current = useIntentWarmup(w, k, d);
    return null;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (props: HookProps) =>
    act(() => {
      root.render(<Probe {...props} />);
    });
  render({ key, delayMs, warm });
  return {
    holder,
    rerender: (key2: string) => render({ key: key2, delayMs, warm }),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const enter = (pointerType = "mouse"): React.PointerEvent =>
  ({ pointerType }) as React.PointerEvent;

describe("useIntentWarmup", () => {
  it("fires after the hover-intent delay", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS - 1));
    expect(warm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("cancels when the pointer leaves before the delay", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS - 50));
    act(() => hook.holder.current.onPointerLeave());
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).not.toHaveBeenCalled();
  });

  it("ignores touch pointers: there is no hover intent on touch", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter("touch")));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).not.toHaveBeenCalled();
  });

  it("treats keyboard focus as intent and blur as cancellation", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onFocus());
    act(() => hook.holder.current.onBlur());
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).not.toHaveBeenCalled();

    act(() => hook.holder.current.onFocus());
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("restarts rather than stacks when intent re-enters mid-delay", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS - 10));
    act(() => hook.holder.current.onPointerLeave());
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("does not fire after unmount", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter()));
    hook.unmount();
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).not.toHaveBeenCalled();
  });

  it("cancels a pending warm when the key changes (route change)", () => {
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "location-1");
    act(() => hook.holder.current.onPointerEnter(enter()));
    hook.rerender("location-2");
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS * 2));
    expect(warm).not.toHaveBeenCalled();
  });

  it("swallows warm rejections: a failed prefetch never breaks the row", () => {
    const warm = vi.fn(() => Promise.reject(new Error("offline")));
    const hook = mountHook(warm, "row-a");
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("keeps the route threshold distinct from the pill threshold", () => {
    expect(ROUTE_WARMUP_DELAY_MS).toBeGreaterThan(INTENT_DELAY_MS);
    const warm = vi.fn(() => Promise.resolve());
    const hook = mountHook(warm, "row-a", ROUTE_WARMUP_DELAY_MS);
    act(() => hook.holder.current.onPointerEnter(enter()));
    act(() => vi.advanceTimersByTime(INTENT_DELAY_MS));
    expect(warm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ROUTE_WARMUP_DELAY_MS - INTENT_DELAY_MS));
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
