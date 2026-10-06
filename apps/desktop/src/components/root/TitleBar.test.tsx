// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { platformState, windowMocks, focusHandlers, showError } = vi.hoisted(
  () => ({
    showError: vi.fn(),
    platformState: { value: "windows", native: true },
    windowMocks: {
      // Each of these stands in for a `@tauri-apps/api/window` method, which
      // returns a Promise that `TitleBar` consumes with `.then()`/`.catch()`.
      // A mock that returned `undefined` would make those chains throw a
      // TypeError, so the promise is the contract being faked, not decoration.
      // Hence `Promise.resolve(...)` rather than a bare value, and rather than
      // `async` — the promise is what is being faked, and marking the mock
      // `async` says nothing the returned promise does not already say.
      minimize: vi.fn(() => Promise.resolve(undefined)),
      maximize: vi.fn(() => Promise.resolve(undefined)),
      unmaximize: vi.fn(() => Promise.resolve(undefined)),
      close: vi.fn(() => Promise.resolve(undefined)),
      startDragging: vi.fn(() => Promise.resolve()),
      isMaximized: vi.fn(() => Promise.resolve(false)),
      isMinimized: vi.fn(() => Promise.resolve(false)),
      onResized: vi.fn((): Promise<() => void> => Promise.resolve(vi.fn())),
      outerSize: vi.fn(() => Promise.resolve({ width: 1280, height: 800 })),
      innerSize: vi.fn((): Promise<{ width: number; height: number }> =>
        windowMocks.outerSize(),
      ),
      scaleFactor: vi.fn(() => Promise.resolve(1)),
      isFocused: vi.fn(() => Promise.resolve(true)),
      onFocusChanged: vi.fn((..._args: unknown[]): Promise<() => void> =>
        Promise.resolve(vi.fn()),
      ),
    },
    focusHandlers: [] as Array<(event: { payload: boolean }) => void>,
  }),
);

vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar: showError }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

vi.mock("../../utils/platform.utils", () => ({
  getPlatform: () => {
    if (!platformState.native)
      throw new Error("OS plugin is unavailable in a browser");
    return platformState.value;
  },
}));

vi.mock("../../utils/env.utils", () => ({
  isTauriRuntime: () => platformState.native,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
}));

vi.mock("./ThemeModeToggle", () => ({
  ThemeModeToggle: () => null,
}));

vi.mock("./WindowResizeHandles", () => ({
  WindowResizeHandles: () => null,
}));

import { TitleBar } from "./TitleBar";
import {
  CAPTION_BUTTON_RADIUS,
  captionButtonSize,
  COMPACT_CAPTION_BUTTON_SIZE,
  MIN_TARGET_SIZE,
  TRAFFIC_DOT_SIZE,
  TRAFFIC_HIT_SIZE,
} from "./titleBarGeometry";
import { captionButtonRestOpacity } from "../../styles/palette";

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  focusHandlers.length = 0;
  windowMocks.isMaximized.mockResolvedValue(false);
  windowMocks.isMinimized.mockResolvedValue(false);
  windowMocks.outerSize.mockResolvedValue({ width: 1280, height: 800 });
  windowMocks.innerSize.mockImplementation(() => windowMocks.outerSize());
  windowMocks.scaleFactor.mockResolvedValue(1);
  windowMocks.onFocusChanged.mockImplementation((handler: unknown) => {
    focusHandlers.push(handler as (event: { payload: boolean }) => void);
    return Promise.resolve(vi.fn());
  });
  platformState.value = "windows";
  platformState.native = true;
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const renderBar = async () => {
  // Flush the mount effect AND its async isFocused()/onFocusChanged()
  // promises so a late resolve cannot overwrite a subsequent focus event.
  //
  // The scope must stay `async` even though the body never awaits: those two
  // native calls resolve in a microtask whose `.then` calls `setFocused` /
  // `setMaximized`. Only an async act scope keeps capturing updates scheduled
  // after the callback returns; a sync one lets them fall outside `act`, and
  // `data-focused` would not be settled when the assertions below read it.
  await act(async () => {
    root.render(createElement(TitleBar));
  });
};

/** Read a px dimension off MUI's emotion classes; jsdom reports 0 for layout. */
const pxOf = (element: HTMLElement, property: "width" | "height"): number =>
  Number.parseFloat(getComputedStyle(element)[property]) || 0;

const buttonByLabel = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;

/**
 * The same lookup, but failing with a readable message instead of a TypeError
 * on null when the control is not rendered.
 */
const requireByLabel = (label: string) => {
  const button = buttonByLabel(label);
  if (!button) throw new Error(`No button with aria-label "${label}"`);
  return button;
};

const requireDragRegion = (): HTMLElement => {
  const region = document.querySelector("[data-tauri-drag-region]");
  if (!(region instanceof HTMLElement)) {
    throw new Error("No [data-tauri-drag-region] element rendered");
  }
  return region;
};

describe("TitleBar on Windows and Linux", () => {
  it("does not let a late initial focus query overwrite a live focus event", async () => {
    let resolve!: (value: boolean) => void;
    windowMocks.isFocused.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderBar();
    await act(() => {
      for (const handler of focusHandlers) handler({ payload: false });
    });
    expect(
      document.querySelector("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("false");
    await act(() => resolve(true));
    expect(
      document.querySelector("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("false");
  });

  it("unsubscribes a focus listener that resolves after unmount", async () => {
    const cleanup = vi.fn();
    let resolve!: (value: () => void) => void;
    windowMocks.onFocusChanged.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderBar();
    act(() => root.render(null));
    await act(() => resolve(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it.each(["windows", "linux"])(
    "puts %s captions flush against the right window edge",
    async (platform) => {
      platformState.value = platform;
      await renderBar();
      const bar = document.querySelector("[data-focused]");
      if (!bar) throw new Error("the title bar did not render");
      expect(Number.parseFloat(getComputedStyle(bar).paddingRight)).toBe(0);
    },
  );
  it("renders safely without the native OS or window plugins", async () => {
    platformState.native = false;
    await renderBar();
    expect(document.body.textContent).toContain("mausVoice");
    expect(windowMocks.isMaximized).not.toHaveBeenCalled();
    expect(windowMocks.isFocused).not.toHaveBeenCalled();
    await act(() => requireByLabel("Minimize").click());
    expect(windowMocks.minimize).not.toHaveBeenCalled();
  });
  it("shows caption buttons, not traffic lights, in the browser preview", async () => {
    platformState.native = false;
    await renderBar();
    expect(buttonByLabel("Close")?.classList.contains("traffic-btn")).toBe(
      false,
    );
    expect(document.querySelector(".traffic-btn")).toBeNull();
  });
  it("uses the shared reduced-motion-aware timing for every caption property", async () => {
    await renderBar();
    // The literal the reference uses is dropped on purpose: `--duration-fast`
    // collapses to 1ms under prefers-reduced-motion, and a hand-written
    // duration would ignore that.
    expect(
      getComputedStyle(requireByLabel("Minimize"))
        .transition.split(",")
        .map((value) => value.trim()),
    ).toEqual([
      "background-color var(--duration-fast) ease",
      "color var(--duration-fast) ease",
      "opacity var(--duration-fast) ease",
      "transform var(--duration-fast) ease",
    ]);
  });

  it("gives close the same hover and press treatment as the other two", async () => {
    await renderBar();
    // One factory call, so the three carry one identical emotion class, which
    // means one identical set of rules. Give close a fill of its own and the
    // class diverges.
    const classes = ["Minimize", "Maximize", "Close"].map(
      (label) => requireByLabel(label).className,
    );
    expect(new Set(classes).size).toBe(1);

    // Class equality would still hold with the interaction rules deleted, so read
    // them out of the stylesheet Emotion injects. jsdom never applies a
    // pseudo-class, which is exactly why the computed style cannot be the thing
    // asserted here.
    const pseudoRules = new Map<string, string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const text = rule.cssText;
        for (const [, className, pseudo] of text.matchAll(
          /\.([\w-]+):(hover|active)\b/g,
        )) {
          pseudoRules.set(`${className}:${pseudo}`, text);
        }
      }
    }

    // Skip MUI's global utility classes: a future `:hover` rule on one of
    // them would be matched first and measured instead of the caption fill.
    // The caption's own class is the one Emotion generates for the `sx`
    // prop, which never carries the `Mui` prefix.
    const captionClass = classes[0]
      .split(" ")
      .find(
        (name) => !name.startsWith("Mui") && pseudoRules.has(`${name}:hover`),
      );
    if (!captionClass) {
      throw new Error("no :hover rule found for the caption cluster");
    }

    const strength = (pseudo: "hover" | "active") => {
      const text = pseudoRules.get(`${captionClass}:${pseudo}`) ?? "";
      const fill =
        text.match(/background-color:\s*([^;}]+)/)?.[1]?.trim() ?? "";
      // The resting value is transparent, so any paint means the rule is real,
      // and a neutral fill has three equal channels.
      expect(fill, `${pseudo} must paint a background`).toBeTruthy();
      const channels = (fill.match(/\d+/g) ?? []).slice(0, 3).map(Number);
      expect(Math.max(...channels), fill).toBe(Math.min(...channels));
      return Number(fill.match(/([\d.]+)\s*\)/)?.[1] ?? 0);
    };

    // Press is stronger than hover, so the two read as a ramp rather than one
    // hover state that never changes.
    expect(strength("active")).toBeGreaterThan(strength("hover"));
  });

  it("draws the caption buttons as rounded square targets, not flush strips", async () => {
    await renderBar();
    for (const label of ["Minimize", "Maximize", "Close"]) {
      const style = getComputedStyle(requireByLabel(label));
      expect(pxOf(requireByLabel(label), "height"), label).toBe(
        captionButtonSize(false),
      );
      expect(pxOf(requireByLabel(label), "width"), label).toBe(
        captionButtonSize(false),
      );
      expect(style.borderRadius, label).toBe(`${CAPTION_BUTTON_RADIUS}px`);
      expect(Number(style.opacity), label).toBeCloseTo(
        captionButtonRestOpacity,
        2,
      );
    }
  });

  it("dims the cluster when the window is unfocused, on top of each button's rest opacity", async () => {
    await renderBar();
    await act(() => {
      for (const handler of focusHandlers) handler({ payload: false });
    });
    // The focus dim rides the cluster wrapper so the three dim as one group. The
    // per-button rest opacity is a separate step, which is why both are asserted.
    const cluster = requireByLabel("Close").parentElement as HTMLElement;
    expect(Number(getComputedStyle(cluster).opacity)).toBeCloseTo(0.6, 2);
    expect(
      Number(getComputedStyle(requireByLabel("Close")).opacity),
    ).toBeCloseTo(captionButtonRestOpacity, 2);
  });

  it("puts caption buttons right of the logo with stable glyphs", async () => {
    await renderBar();

    const minimize = buttonByLabel("Minimize");
    const maximize = buttonByLabel("Maximize");
    const close = buttonByLabel("Close");
    expect(minimize?.tagName).toBe("BUTTON");
    expect(maximize?.tagName).toBe("BUTTON");
    expect(close?.tagName).toBe("BUTTON");

    // Logo text renders before the caption buttons in DOM order.
    const body = document.body.innerHTML;
    expect(body.indexOf("mausVoice")).toBeLessThan(
      body.indexOf('aria-label="Minimize"'),
    );
    expect(document.querySelector(".traffic-btn")).toBeNull();

    await act(() => {
      minimize!.click();
    });
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);

    await act(() => {
      maximize!.click();
    });
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
    expect(buttonByLabel("Restore")).toBeTruthy();

    await act(() => {
      close!.click();
    });
    expect(windowMocks.close).toHaveBeenCalledTimes(1);
  });

  it("marks focus state for styling and dims when unfocused", async () => {
    await renderBar();

    const bar = document.querySelector("[data-focused]");
    expect(bar?.getAttribute("data-focused")).toBe("true");

    await act(() => {
      for (const handler of focusHandlers) {
        handler({ payload: false });
      }
    });
    expect(
      document.querySelector("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("false");
  });

  it("toggles maximize and restore on consecutive double clicks of the drag region", async () => {
    await renderBar();

    const dragRegion = requireDragRegion();
    await act(async () => {
      dragRegion.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
    expect(buttonByLabel("Restore")).toBeTruthy();

    await act(async () => {
      dragRegion.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(windowMocks.unmaximize).toHaveBeenCalledTimes(1);
    expect(buttonByLabel("Maximize")).toBeTruthy();
  });

  it("stops drag-region mousedown and mouseup from bubbling to document and only starts dragging after pointer movement", async () => {
    await renderBar();

    const dragRegion = requireDragRegion();
    const documentMouseDown = vi.fn();
    const documentMouseUp = vi.fn();
    document.addEventListener("mousedown", documentMouseDown);
    document.addEventListener("mouseup", documentMouseUp);

    try {
      // Stationary click + double-click: must not bubble to Tauri's
      // document-level `drag.js` listener or invoke `startDragging`, even if
      // the pointer later moves >= 4px with no button held (`buttons: 0`).
      await act(() => {
        dragRegion.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 0,
            detail: 1,
            clientX: 100,
            clientY: 20,
          }),
        );
        dragRegion.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            button: 0,
            detail: 1,
            clientX: 100,
            clientY: 20,
          }),
        );
        window.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            buttons: 0,
            clientX: 110,
            clientY: 20,
          }),
        );
        dragRegion.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 0,
            detail: 2,
            clientX: 100,
            clientY: 20,
          }),
        );
        dragRegion.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            button: 0,
            detail: 2,
            clientX: 100,
            clientY: 20,
          }),
        );
      });
      expect(documentMouseDown).not.toHaveBeenCalled();
      expect(documentMouseUp).not.toHaveBeenCalled();
      expect(windowMocks.startDragging).not.toHaveBeenCalled();

      // Pointer press followed by movement >= 4px starts native window drag.
      await act(() => {
        dragRegion.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 0,
            detail: 1,
            clientX: 100,
            clientY: 20,
          }),
        );
        window.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            buttons: 1,
            clientX: 106,
            clientY: 20,
          }),
        );
      });
      expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("mousedown", documentMouseDown);
      document.removeEventListener("mouseup", documentMouseUp);
    }
  });
});

describe("TitleBar on macOS", () => {
  beforeEach(() => {
    platformState.value = "macos";
  });

  it("puts traffic lights left of the logo", async () => {
    await renderBar();

    const close = buttonByLabel("Close");
    const minimize = buttonByLabel("Minimize");
    const maximize = buttonByLabel("Maximize");
    expect(close?.classList.contains("traffic-btn")).toBe(true);
    expect(minimize?.classList.contains("traffic-btn")).toBe(true);
    expect(maximize?.classList.contains("traffic-btn")).toBe(true);

    const body = document.body.innerHTML;
    expect(body.indexOf('aria-label="Close"')).toBeLessThan(
      body.indexOf("mausVoice"),
    );
  });

  it("gives every macOS traffic light a hit target at or above the WCAG 2.2 minimum", async () => {
    platformState.value = "macos";
    await renderBar();

    for (const label of ["Close", "Minimize", "Maximize"]) {
      const button = buttonByLabel(label);
      expect(button, `${label} should render`).not.toBeNull();
      // jsdom reports 0 for unlaid-out boxes, so assert against the computed
      // inline sizing MUI applies rather than a layout-derived measurement.
      expect(
        pxOf(button!, "width"),
        `${label} hit target must be >= ${MIN_TARGET_SIZE}px`,
      ).toBeGreaterThanOrEqual(MIN_TARGET_SIZE);
      expect(pxOf(button!, "height")).toBeGreaterThanOrEqual(MIN_TARGET_SIZE);
    }
  });

  it("keeps the painted dot smaller than the hit target on macOS", async () => {
    platformState.value = "macos";
    await renderBar();

    const dot = document.querySelector(".traffic-dot");
    if (!(dot instanceof HTMLElement)) {
      throw new Error("the macOS traffic-light dot did not render");
    }
    // The 12px dot is the native proportion and stays; only the hit area grew.
    expect(pxOf(dot, "width")).toBe(TRAFFIC_DOT_SIZE);
    expect(pxOf(dot, "height")).toBe(TRAFFIC_DOT_SIZE);
    expect(TRAFFIC_HIT_SIZE).toBeGreaterThan(TRAFFIC_DOT_SIZE);
  });

  it("wires traffic buttons to window actions", async () => {
    await renderBar();

    await act(() => {
      requireByLabel("Close").click();
    });
    expect(windowMocks.close).toHaveBeenCalledTimes(1);

    await act(() => {
      requireByLabel("Minimize").click();
    });
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);

    await act(() => {
      requireByLabel("Maximize").click();
    });
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
  });

  it("starts dragging on mousedown and toggles maximize once on stationary double-click release", async () => {
    await renderBar();

    const dragRegion = requireDragRegion();
    await act(() => {
      dragRegion.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          detail: 1,
          clientX: 120,
          clientY: 20,
        }),
      );
    });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);

    // Second click of a double-click on macOS: must not start another drag,
    // and must toggle maximize exactly once even if `dblclick` also fires
    // after microtasks drain between `mouseup` and `dblclick`.
    await act(async () => {
      dragRegion.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          detail: 2,
          clientX: 120,
          clientY: 20,
        }),
      );
      dragRegion.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          detail: 2,
          clientX: 120,
          clientY: 20,
        }),
      );
      await Promise.resolve();
      dragRegion.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          button: 0,
          detail: 2,
          clientX: 120,
          clientY: 20,
        }),
      );
    });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
  });
});

it("narrows the caption buttons and hides the wordmark on a narrow window", async () => {
  windowMocks.outerSize.mockResolvedValue({ width: 400, height: 600 });
  await renderBar();

  const wordmark = [...document.querySelectorAll("span")].find(
    (node) => node.textContent === "mausVoice",
  );
  expect(pxOf(requireByLabel("Close"), "width")).toBe(
    COMPACT_CAPTION_BUTTON_SIZE,
  );
  // The wordmark is the first thing to go on a narrow bar.
  expect(getComputedStyle(wordmark!).display).toBe("none");
});

it("keeps the roomy bar on a wide window", async () => {
  windowMocks.outerSize.mockResolvedValue({ width: 1280, height: 800 });
  await renderBar();

  const wordmark = [...document.querySelectorAll("span")].find(
    (node) => node.textContent === "mausVoice",
  );
  expect(pxOf(requireByLabel("Close"), "width")).toBe(captionButtonSize(false));
  expect(getComputedStyle(wordmark!).display).not.toBe("none");
});

it("re-evaluates density when the window is resized", async () => {
  // Every other density test sets the size before mount, so only the initial
  // read is covered. The resize path is the one that runs in real use.
  let fireResize: (() => void) | undefined;
  // Tauri's `onResized` hands the callback to the runtime, but its published
  // type takes no arguments, so the captured handler needs a cast here.
  windowMocks.onResized.mockImplementation(((
    handler: () => void,
  ): Promise<() => void> => {
    fireResize = handler;
    return Promise.resolve(() => undefined);
  }) as never);
  windowMocks.outerSize.mockResolvedValue({ width: 1280, height: 800 });
  await renderBar();
  expect(pxOf(requireByLabel("Close"), "width")).toBe(captionButtonSize(false));

  windowMocks.outerSize.mockResolvedValue({ width: 820, height: 700 });
  await act(async () => {
    fireResize?.();
  });
  expect(pxOf(requireByLabel("Close"), "width")).toBe(
    COMPACT_CAPTION_BUTTON_SIZE,
  );
});

it("keeps the newest density when resize ticks resolve out of order", async () => {
  // A resize drag fires `onResized` on every tick, and each tick awaits an IPC
  // round trip. Those responses are unordered, so a slow earlier tick can land
  // after a newer one. Without a sequence guard the stale width wins and the
  // bar keeps a density that no longer matches the window.
  let fireResize: (() => void) | undefined;
  windowMocks.onResized.mockImplementation(((
    handler: () => void,
  ): Promise<() => void> => {
    fireResize = handler;
    return Promise.resolve(() => undefined);
  }) as never);

  // Two ticks in flight: the first (wide) resolves last, the second (narrow)
  // resolves first. Only the second reflects the window's final size.
  let resolveWide!: (size: { width: number; height: number }) => void;
  let resolveNarrow!: (size: { width: number; height: number }) => void;
  windowMocks.outerSize
    .mockReturnValueOnce(
      new Promise((done) => {
        resolveWide = done;
      }),
    )
    .mockReturnValueOnce(
      new Promise((done) => {
        resolveNarrow = done;
      }),
    )
    .mockResolvedValue({ width: 820, height: 700 });
  await renderBar();

  await act(async () => {
    fireResize?.();
    fireResize?.();
  });

  // The newer tick lands first and compacts the bar.
  await act(async () => {
    resolveNarrow({ width: 820, height: 700 });
  });
  expect(pxOf(requireByLabel("Close"), "width")).toBe(
    COMPACT_CAPTION_BUTTON_SIZE,
  );

  // The older, wider tick now lands late. It must be discarded rather than
  // widening the bar back to a size the window is no longer at.
  await act(async () => {
    resolveWide({ width: 1280, height: 800 });
  });
  expect(pxOf(requireByLabel("Close"), "width")).toBe(
    COMPACT_CAPTION_BUTTON_SIZE,
  );
});

it("registers a single onResized listener", async () => {
  // Two independent `onResized` subscriptions meant every tick of a resize
  // drag issued duplicated IPC. `useMaximized` and the density hook now share
  // one subscription.
  windowMocks.outerSize.mockResolvedValue({ width: 1280, height: 800 });
  await renderBar();

  expect(windowMocks.onResized).toHaveBeenCalledTimes(1);
});

it("compares against logical pixels, so a scaled display still compacts", async () => {
  // A 200% display reports twice the physical width for the same window. The
  // threshold is in CSS pixels, so a narrow window must still compact.
  windowMocks.scaleFactor.mockResolvedValue(2);
  windowMocks.outerSize.mockResolvedValue({ width: 1640, height: 1200 });
  await renderBar();

  expect(pxOf(requireByLabel("Close"), "width")).toBe(
    COMPACT_CAPTION_BUTTON_SIZE,
  );
});

it("keeps the roomy bar when the window size is not known yet", async () => {
  // Browser preview has no window to measure. It must not flash compact.
  platformState.native = false;
  await renderBar();

  expect(pxOf(requireByLabel("Close"), "width")).toBe(captionButtonSize(false));
});

it("ignores minimized resize ticks so minimizing a wide or maximized window does not flip to compact or clear maximize state", async () => {
  let fireResize:
    | ((event?: { payload?: { width: number; height: number } }) => void)
    | undefined;
  windowMocks.onResized.mockImplementation(((
    handler: (event?: { payload?: { width: number; height: number } }) => void,
  ): Promise<() => void> => {
    fireResize = handler;
    return Promise.resolve(() => undefined);
  }) as never);
  windowMocks.isMaximized.mockResolvedValue(true);
  windowMocks.innerSize.mockResolvedValue({ width: 1920, height: 1080 });
  await renderBar();
  expect(buttonByLabel("Restore")).toBeTruthy();
  expect(pxOf(requireByLabel("Close"), "width")).toBe(captionButtonSize(false));

  // Windows WM_SIZE SIZE_MINIMIZED emits a (0, 0) payload and reports the
  // 160x28 iconic taskbar rect from GetWindowRect while isMinimized() is true.
  windowMocks.isMinimized.mockResolvedValue(true);
  windowMocks.isMaximized.mockResolvedValue(false);
  windowMocks.innerSize.mockResolvedValue({ width: 160, height: 28 });
  await act(async () => {
    fireResize?.({ payload: { width: 0, height: 0 } });
    fireResize?.();
    await Promise.resolve();
  });

  expect(buttonByLabel("Restore")).toBeTruthy();
  expect(pxOf(requireByLabel("Close"), "width")).toBe(captionButtonSize(false));
});

it("discards an in-flight resize measurement that started before an optimistic maximize toggle", async () => {
  let fireResize: (() => void) | undefined;
  windowMocks.onResized.mockImplementation(((
    handler: () => void,
  ): Promise<() => void> => {
    fireResize = handler;
    return Promise.resolve(() => undefined);
  }) as never);
  await renderBar();

  let resolveStaleMax!: (value: boolean) => void;
  windowMocks.isMaximized.mockReturnValueOnce(
    new Promise((done) => {
      resolveStaleMax = done;
    }),
  );
  await act(() => {
    fireResize?.();
  });

  // User clicks Maximize while the earlier resize tick is still awaiting
  // `isMaximized()`.
  windowMocks.isMaximized.mockResolvedValueOnce(false);
  await act(async () => {
    requireByLabel("Maximize").click();
    await Promise.resolve();
  });
  expect(buttonByLabel("Restore")).toBeTruthy();

  // The stale pre-maximize resize measurement resolves `false` late and must
  // not overwrite the optimistic `Restore` state.
  await act(async () => {
    resolveStaleMax(false);
    await Promise.resolve();
  });
  expect(buttonByLabel("Restore")).toBeTruthy();
});

it.each([
  ["windows", "Minimize", "minimize"],
  ["windows", "Maximize", "maximize"],
  ["windows", "Close", "close"],
  ["macos", "Minimize", "minimize"],
  ["macos", "Maximize", "maximize"],
  ["macos", "Close", "close"],
] as const)(
  "handles %s %s command rejection instead of leaving an unhandled promise",
  async (platform, label, command) => {
    platformState.value = platform;
    const error = new Error("window command failed");
    windowMocks[command].mockRejectedValueOnce(error);
    await renderBar();
    await act(() => requireByLabel(label).click());
    expect(showError).toHaveBeenCalledWith(error);
  },
);
