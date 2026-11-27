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
    setPosition: vi.fn((_position: { x: number; y: number }) =>
      Promise.resolve(undefined),
    ),
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
}));

import { useWindowDrag } from "./useWindowDrag";

ensureUiHarness();

type Harness = {
  maximizedRef: { current: boolean };
  toggleMaximized: () => void;
  handlers: ReturnType<typeof useWindowDrag> | null;
};

let container: HTMLDivElement;
let root: Root;

const renderHook = async (maximized: boolean, toggleMaximized = vi.fn()) => {
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  platformState.value = "windows";
  platformState.native = true;
  windowMocks.innerSize.mockResolvedValue({ width: 1920, height: 1040 });
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

  it("places the restored window in logical pixels on a scaled display", async () => {
    // `cursorPosition` reports physical pixels while the window size is
    // logical, so a 2x display would otherwise place the window at twice the
    // pointer's offset and jump it off to one side.
    windowMocks.innerSize.mockResolvedValue({ width: 1280, height: 800 });
    windowMocks.cursorPosition.mockResolvedValue({ x: 800, y: 600 });
    windowMocks.scaleFactor.mockResolvedValue(2);
    const { handlers } = await renderHook(true);
    await press(handlers!, 1, { x: 160, y: 20 });
    await move(1, 160, 60);

    const [placed] = windowMocks.setPosition.mock.calls[0];
    expect({ x: placed.x, y: placed.y }).toEqual({
      x: 400 - (160 / 1280) * 1280,
      y: 300 - 20,
    });
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
    windowMocks.innerPosition.mockRejectedValueOnce(new Error("no position"));
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
