// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { platformState, windowMocks, showError } = vi.hoisted(() => ({
  showError: vi.fn(),
  platformState: { value: "windows", native: true },
  windowMocks: {
    minimize: vi.fn(() => Promise.resolve(undefined)),
    maximize: vi.fn(() => Promise.resolve(undefined)),
    unmaximize: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve(undefined)),
    startDragging: vi.fn(() => Promise.resolve(undefined)),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    innerSize: vi.fn(() => Promise.resolve({ width: 1920, height: 1040 })),
    innerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    cursorPosition: vi.fn(() =>
      Promise.resolve({ x: 400, y: 300 } as { x: number; y: number } | null),
    ),
    currentMonitor: vi.fn(() =>
      Promise.resolve({ workArea: { position: { x: 0, y: 0 } } }),
    ),
    // The placement prefers the monitor under the pointer; an empty list keeps
    // the existing tests on the window's own monitor, which is the fallback.
    // Structural stand-in for the Tauri `Monitor`: the placement only reads the
    // work-area rectangle, and a real `Monitor` needs IPC-class instances.
    availableMonitors: vi.fn(
      (): Promise<
        {
          position?: { x: number; y: number };
          size?: { width: number; height: number };
          workArea: {
            position: { x: number; y: number };
            size: { width: number; height: number };
          };
        }[]
      > => Promise.resolve([]),
    ),
    setPosition: vi.fn((_position: { x: number; y: number }) =>
      Promise.resolve(undefined),
    ),
    // The default fires the resize at once, so a test that is not about the
    // wait does not have to drive it. The one test that is about the wait
    // replaces this with a handler it controls.
    onResized: vi.fn((handler: () => void): Promise<() => void> => {
      handler();
      return Promise.resolve(() => undefined);
    }),
    // The pointer arrives in physical pixels, so the placement scales it back
    // to the logical space the size was read in.
    scaleFactor: vi.fn(() => Promise.resolve(1)),
  },
}));

vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar: showError }));
vi.mock("../../utils/platform.utils", () => ({
  getPlatform: () => platformState.value,
}));
vi.mock("../../utils/env.utils", () => ({
  isTauriRuntime: () => platformState.native,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
  // The placement reads the pointer and the monitor as module functions, not
  // as window methods, so the mock has to carry them too.
  cursorPosition: () => windowMocks.cursorPosition(),
  currentMonitor: () => windowMocks.currentMonitor(),
  availableMonitors: () => windowMocks.availableMonitors(),
}));

import { useWindowDrag } from "./useWindowDrag";

ensureUiHarness();

type Harness = {
  maximizedRef: { current: boolean | undefined };
  toggleMaximized: () => void;
  handlers: ReturnType<typeof useWindowDrag> | null;
};

let container: HTMLDivElement;
let root: Root;

const renderHook = async (
  maximized: boolean | undefined,
  toggleMaximized = vi.fn(),
) => {
  const harness: Harness = {
    maximizedRef: { current: maximized },
    toggleMaximized,
    handlers: null,
  };
  const Probe = () => {
    harness.handlers = useWindowDrag(
      harness.maximizedRef,
      harness.toggleMaximized,
    );
    return createElement("div");
  };
  await act(async () => {
    root.render(createElement(Probe));
  });
  return harness;
};

const press = async (
  handlers: ReturnType<typeof useWindowDrag>,
  detail = 1,
  point = { x: 400, y: 20 },
) => {
  await act(async () => {
    handlers.onMouseDown({
      button: 0,
      detail,
      clientX: point.x,
      clientY: point.y,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent<HTMLElement>);
  });
};

/**
 * Dispatches a real `mousemove` and drains the restore chain it starts.
 *
 * The chain is four awaited Tauri calls deep, so a fixed number of microtask
 * turns would depend on how many of them each fake resolves through. A
 * macrotask flushes all of them and is what a browser would deliver anyway.
 */
const move = async (buttons: number, x: number, y: number) => {
  await act(async () => {
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        buttons,
        clientX: x,
        clientY: y,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` drops call history but not a `mockImplementation`, so each
  // fake is given back the behaviour it starts with. Without this, the test
  // that controls the resize event leaks its controller into the next one.
  windowMocks.onResized.mockImplementation(
    (handler: () => void): Promise<() => void> => {
      handler();
      return Promise.resolve(() => undefined);
    },
  );
  windowMocks.unmaximize.mockImplementation(() => Promise.resolve(undefined));
  platformState.value = "windows";
  platformState.native = true;
  windowMocks.innerSize.mockResolvedValue({ width: 1920, height: 1040 });
  // Every fake that a test overrides has to come back here, or the override
  // leaks: a `scaleFactor` of 2 left behind by the scaled-display test silently
  // halved a later test's expectations.
  windowMocks.scaleFactor.mockResolvedValue(1);
  windowMocks.availableMonitors.mockResolvedValue([]);
  windowMocks.innerPosition.mockResolvedValue({ x: 0, y: 0 });
  windowMocks.cursorPosition.mockResolvedValue({ x: 400, y: 300 });
  windowMocks.currentMonitor.mockResolvedValue({
    workArea: { position: { x: 0, y: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("Windows drag-to-restore", () => {
  it("restores a maximized window and hands the drag to the OS when the pointer leaves the bar", async () => {
    // The report behind this test: dragging a maximized bar did nothing, or
    // restored without keeping the window on the pointer.
    const { handlers } = await renderHook(true);
    await press(handlers!);
    expect(windowMocks.startDragging).not.toHaveBeenCalled();

    await move(1, 400, 60);

    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    // The restore is followed by one placement, and the placement is derived
    // from the pointer rather than from the restore rectangle the OS chose.
    // Read the fields rather than deep-comparing the argument: the call takes a
    // `LogicalPosition`, whose own `type` and methods are not part of the
    // placement being asserted.
    const [placed] = windowMocks.setPosition.mock.calls[0];
    expect({ x: placed.x, y: placed.y }).toEqual({
      x: 400 - (400 / 1920) * 1920,
      y: 300 - 20,
    });
  });

  it("waits for the restored size before placing the window", async () => {
    // `unmaximize()` resolving is not proof of the restore: on Windows `tao`
    // posts the resize to the event-loop thread, so a size read straight after
    // it can still be the maximized geometry. The window here keeps reporting
    // full-screen size until the resize event arrives, exactly like that race.
    let restored = false;
    let fireResize: (() => void) | null = null;
    windowMocks.onResized.mockImplementation(
      (handler: () => void) =>
        new Promise<() => void>((resolve) => {
          fireResize = handler;
          resolve(() => undefined);
        }),
    );
    windowMocks.innerSize.mockImplementation(() =>
      Promise.resolve(
        restored ? { width: 800, height: 600 } : { width: 1920, height: 1040 },
      ),
    );
    windowMocks.unmaximize.mockImplementation(() => {
      restored = true;
      return Promise.resolve(undefined);
    });
    windowMocks.cursorPosition.mockResolvedValue({ x: 400, y: 300 });
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 480, y: 20 });

    await move(1, 480, 60);
    expect(windowMocks.setPosition).not.toHaveBeenCalled();

    await act(async () => {
      fireResize?.();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const [placed] = windowMocks.setPosition.mock.calls[0];
    // The fraction came from the maximized width (480 / 1920), and it is
    // applied to the restored one, which is only correct if the placement
    // waited for the resize.
    expect({ x: placed.x, y: placed.y }).toEqual({
      x: 400 - (480 / 1920) * 800,
      y: 300 - 20,
    });
  });

  it("still hands the drag over when the placement fails", async () => {
    // The restore succeeded, so the person is holding a restored window under
    // the pointer. Losing the handoff as well would leave a stuck window and a
    // dead gesture, which is worse than a window the OS placed on its own.
    windowMocks.setPosition.mockRejectedValueOnce(new Error("denied"));
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("does not start the drag when the button comes up during the restore", async () => {
    // The press's own listeners are torn down when the restore starts, so a
    // release in that window is only visible if something is still watching for
    // it. Otherwise the window starts moving after the button is already up.
    let fireResize: (() => void) | null = null;
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        fireResize = handler;
        return Promise.resolve(() => undefined);
      },
    );
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      fireResize?.();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
  });

  it("subscribes to the resize before asking for the restore", async () => {
    // `onResized` only listens from the moment it is called and never replays a
    // resize that has already happened, so a restore that lands quickly is
    // missed if the listener is registered afterwards. The order below is the
    // whole guarantee, so the test records when each one happened.
    const order: string[] = [];
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        order.push("subscribe");
        handler();
        return Promise.resolve(() => undefined);
      },
    );
    windowMocks.unmaximize.mockImplementation(() => {
      order.push("unmaximize");
      return Promise.resolve(undefined);
    });
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    expect(order).toEqual(["subscribe", "unmaximize"]);
  });

  it("reports an unmeasurable placement instead of skipping it silently", async () => {
    // The drag still continues, because the window is restored and following
    // the pointer; what must not happen is the placement vanishing without a
    // word, which is the difference between a quiet no-op and a bug report.
    windowMocks.cursorPosition.mockRejectedValue(new Error("no pointer"));
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });

    expect(windowMocks.setPosition).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalled();
  });

  it("registers the resize listener before it asks for the restore", async () => {
    // `onResized` is an IPC round trip, so the listener is not live the moment
    // it is called. A restore that lands during that window is missed, and the
    // wait then falls back to its timeout and places against stale geometry.
    // The subscription here resolves late, which is what a real round trip
    // does and what the synchronous fake could not show.
    const order: string[] = [];
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> =>
        new Promise((resolve) => {
          order.push("subscribe-requested");
          window.setTimeout(() => {
            order.push("subscribe-registered");
            handler();
            resolve(() => undefined);
          }, 20);
        }),
    );
    windowMocks.unmaximize.mockImplementation(() => {
      order.push("unmaximize");
      return Promise.resolve(undefined);
    });
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);
    // Drain the deferred subscription, so its timer cannot fire inside the
    // next test and reorder that test's call log.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });

    expect(order).toEqual([
      "subscribe-requested",
      "subscribe-registered",
      "unmaximize",
    ]);
  });

  it("spends the settle allowance after the restore is requested", async () => {
    // The allowance exists for the restore, not for the measurement before it.
    // A slow `innerSize`/`scaleFactor` pair must not eat it, or the timeout
    // expires first and the placement reads pre-restore geometry.
    const order: string[] = [];
    windowMocks.innerSize.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("measure");
          window.setTimeout(() => {
            order.push("measure:done");
            resolve({ width: 1600, height: 1000 });
          }, 20);
        }),
    );
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        order.push("arm");
        handler();
        return Promise.resolve(() => undefined);
      },
    );
    windowMocks.unmaximize.mockImplementation(() => {
      order.push("unmaximize");
      return Promise.resolve(undefined);
    });
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });

    // `scaleFactor` is read in the same `Promise.all`, so the meaningful
    // guarantee is that arming comes after the measurement finishes.
    expect(order.indexOf("arm")).toBeGreaterThan(order.indexOf("measure:done"));
    expect(order.indexOf("arm")).toBeLessThan(order.indexOf("unmaximize"));
  });

  it("still cancels the handoff when the window loses focus", async () => {
    // A blur ends the interaction with no button release to observe, so the
    // pending restore must not go on to start a native drag.
    let fireResize: (() => void) | null = null;
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        fireResize = handler;
        return Promise.resolve(() => undefined);
      },
    );
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      fireResize?.();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
  });

  it("keeps the handoff when a secondary button is released mid-restore", async () => {
    // Only the primary button ends a primary drag. A right-click release while
    // the left button is still down must not cancel the move.
    let fireResize: (() => void) | null = null;
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        fireResize = handler;
        return Promise.resolve(() => undefined);
      },
    );
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, button: 2 }),
      );
      fireResize?.();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("keeps one unit on a scaled display", async () => {
    // Every Tauri read here is physical: `innerSize`, `cursorPosition` and the
    // monitor work area. The browser press is CSS pixels, so it has to be
    // scaled up before it is turned into a fraction, and the result scaled back
    // down for `setPosition`. At 2x with a 1600x1000 physical window, a press
    // 100 CSS pixels in is 200 physical pixels, and a quarter of the width.
    windowMocks.innerSize.mockResolvedValue({ width: 1600, height: 1000 });
    windowMocks.cursorPosition.mockResolvedValue({ x: 800, y: 600 });
    windowMocks.scaleFactor.mockResolvedValue(2);
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 100, y: 10 });
    await move(1, 100, 60);

    const [placed] = windowMocks.setPosition.mock.calls[0];
    // A quarter of the way along means 0.25 of the *restored* width, which
    // this fake also reports as 1600 because it does not change size. So the
    // physical left edge is 800 - 0.25 * 1600 and the top is 600 - 20, and both
    // are halved for the logical `setPosition`.
    expect({ x: placed.x, y: placed.y }).toEqual({
      x: (800 - (200 / 1600) * 1600) / 2,
      y: (600 - 20) / 2,
    });
  });

  it("clamps to a nonzero work-area origin on a scaled display", async () => {
    // The two halves of the arithmetic meet here: the origin comes from the
    // monitor in physical pixels, the press comes from the browser in CSS
    // pixels, and the clamp compares them. A monitor left of and above the
    // primary has a negative origin, so a clamp that mixed units or assumed
    // zero would put the bar off the top of that screen. The pointer is high
    // enough that the unclamped top, 600 physical pixels above the window
    // origin, would land above the work area entirely.
    windowMocks.innerSize.mockResolvedValue({ width: 1600, height: 1000 });
    windowMocks.cursorPosition.mockResolvedValue({ x: 800, y: -100 });
    windowMocks.currentMonitor.mockResolvedValue({
      workArea: { position: { x: -1920, y: -40 } },
    });
    windowMocks.scaleFactor.mockResolvedValue(2);
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 100, y: 10 });
    await move(1, 100, 60);

    const [placed] = windowMocks.setPosition.mock.calls[0];
    // -100 - 20 is above the origin, so the top is pinned to -40 physical and
    // both coordinates are halved for the logical `setPosition`.
    expect({ x: placed.x, y: placed.y }).toEqual({
      x: (800 - (200 / 1600) * 1600) / 2,
      y: -40 / 2,
    });
  });

  it("restores when the press lands before the bar has measured the window", async () => {
    // The bar's maximize flag is only known after its first asynchronous read.
    // A press before that used to look like a restored window and hand a
    // maximized one to the OS move loop, which lands it at its saved rectangle.
    windowMocks.isMaximized.mockResolvedValue(true);
    const { handlers } = await renderHook(undefined);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    expect(windowMocks.isMaximized).toHaveBeenCalled();
    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.setPosition).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("does not restore when the late measurement says the window is restored", async () => {
    windowMocks.isMaximized.mockResolvedValue(false);
    const { handlers } = await renderHook(undefined);
    await press(handlers!, 1, { x: 400, y: 20 });
    await move(1, 400, 60);

    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("clamps against the monitor under the pointer, not the window", async () => {
    // A maximized window can span two displays with different work areas. The
    // window's own monitor would supply the wrong top origin for a pointer
    // that is on the other one, and the clamp would use it.
    // The restore has already landed here, so the size is the restored one:
    // the fresh window reads 1600 physical px while the maximized press was
    // measured against 3200, making the grab 200px in and 20px down.
    let phase = "maximized";
    windowMocks.innerSize.mockImplementation(() => {
      if (phase === "maximized")
        return Promise.resolve({ width: 3200, height: 1000 });
      return new Promise((resolve) =>
        window.setTimeout(() => resolve({ width: 1600, height: 1000 }), 0),
      );
    });
    windowMocks.onResized.mockImplementation(
      (handler: () => void): Promise<() => void> => {
        phase = "restored";
        handler();
        return Promise.resolve(() => undefined);
      },
    );
    // The pointer is a little above the left monitor's work area, so the
    // unclamped top would sit under the taskbar and the clamp has to act.
    windowMocks.cursorPosition.mockResolvedValue({ x: -1810, y: -235 });
    windowMocks.currentMonitor.mockResolvedValue({
      workArea: { position: { x: 0, y: 0 } },
    });
    windowMocks.availableMonitors.mockResolvedValue([
      {
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
        workArea: {
          position: { x: 0, y: 0 },
          size: { width: 1920, height: 1040 },
        },
      },
      {
        position: { x: -1920, y: -200 },
        size: { width: 1920, height: 1080 },
        workArea: {
          position: { x: -1920, y: -240 },
          size: { width: 1920, height: 1040 },
        },
      },
    ]);
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 100, y: 10 });
    await move(1, 100, 60);
    // Let the restore chain run to the placement before reading the call.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });

    // The pointer is on the left-hand monitor, whose work area starts at
    // -240. The grab is 100 physical px in against a 3200 wide maximized
    // window, which is 50 px of the restored 1600, so x is -1810 - 50. The
    // unclamped top is -235 - 10 = -245, which the clamp lifts to -240.
    const [placed] = windowMocks.setPosition.mock.calls[0];
    expect({ x: placed.x, y: placed.y }).toEqual({ x: -1860, y: -240 });
  });

  it("restores on a sideways drag that stays on the bar", async () => {
    // A maximized window already fills the work area. A horizontal drag that
    // stayed on the bar used to move nothing at all.
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 420, 20);

    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("keeps a jittery press a click", async () => {
    const { handlers } = await renderHook(true);
    await press(handlers!);
    // Below the drag threshold: no drag, no restore.
    await move(1, 402, 21);

    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
  });

  it("keeps a click with an unsteady hand a click", async () => {
    // Three pixels of drift is inside the drag threshold, and Windows' own
    // `SM_CXDRAG` default agrees, so it is not a drag.
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 403, 21);

    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
  });

  it("moves an already restored window without unmaximizing it", async () => {
    const { handlers } = await renderHook(false);
    await press(handlers!);
    await move(1, 400, 60);

    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
    expect(windowMocks.setPosition).not.toHaveBeenCalled();
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("does not start a drag after the button is released", async () => {
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await act(async () => {
      handlers!.onMouseUp({
        button: 0,
        detail: 1,
        clientX: 400,
        clientY: 20,
        stopPropagation: vi.fn(),
      } as unknown as React.MouseEvent<HTMLElement>);
    });
    await move(0, 400, 200);

    expect(windowMocks.startDragging).not.toHaveBeenCalled();
    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
  });

  it("restores once even when the pointer keeps moving", async () => {
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 400, 60);
    await move(1, 400, 80);

    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed unmaximize instead of leaving an unhandled rejection", async () => {
    const error = new Error("unmaximize failed");
    windowMocks.unmaximize.mockRejectedValueOnce(error);
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 400, 60);

    expect(showError).toHaveBeenCalledWith(error);
  });

  it("hands the drag over even when the grab point cannot be measured", async () => {
    // A failed measurement must not strand the gesture: the window still has
    // to follow the pointer, just without the placement correction.
    windowMocks.scaleFactor.mockRejectedValueOnce(new Error("no scale"));
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 400, 60);

    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });
});

describe("double-click", () => {
  it("skips the OS double-click on a maximized window's second press", async () => {
    const { handlers } = await renderHook(true);
    await press(handlers!, 2);
    expect(windowMocks.startDragging).not.toHaveBeenCalled();
    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize through the double-click handler", async () => {
    const toggle = vi.fn();
    const { handlers } = await renderHook(false, toggle);
    await act(async () => {
      handlers!.onDoubleClick();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("macOS", () => {
  beforeEach(() => {
    platformState.value = "macos";
  });

  it("starts the drag on the press, which AppKit then follows", async () => {
    const { handlers } = await renderHook(true);
    await press(handlers!);

    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    // AppKit restores a zoomed window and keeps it under the pointer itself,
    // so the manual restore must not run there.
    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize once on a stationary second release and skips the synthesized dblclick", async () => {
    const toggle = vi.fn();
    const { handlers } = await renderHook(false, toggle);
    await press(handlers!, 2, { x: 400, y: 20 });
    // Release and the `dblclick` WebKit synthesizes from it land in the same
    // task, so they are dispatched in one block here too.
    await act(async () => {
      handlers!.onMouseUp({
        button: 0,
        detail: 2,
        clientX: 400,
        clientY: 20,
        stopPropagation: vi.fn(),
      } as unknown as React.MouseEvent<HTMLElement>);
      handlers!.onDoubleClick();
    });

    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("browser preview", () => {
  it("does nothing without the native window", async () => {
    platformState.native = false;
    const { handlers } = await renderHook(true);
    await press(handlers!);
    await move(1, 400, 60);

    expect(windowMocks.startDragging).not.toHaveBeenCalled();
    expect(windowMocks.unmaximize).not.toHaveBeenCalled();
  });
});
