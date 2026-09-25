// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { platformState, windowMocks, focusHandlers, showError } = vi.hoisted(
  () => ({
    showError: vi.fn(),
    platformState: { value: "windows", native: true },
    windowMocks: {
      minimize: vi.fn(async () => undefined),
      maximize: vi.fn(async () => undefined),
      unmaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
      onResized: vi.fn(async (): Promise<() => void> => vi.fn()),
      isFocused: vi.fn(async () => true),
      onFocusChanged: vi.fn(async (..._args: unknown[]): Promise<() => void> =>
        vi.fn(),
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
  windowMocks.onFocusChanged.mockImplementation(async (handler: unknown) => {
    focusHandlers.push(handler as (event: { payload: boolean }) => void);
    return vi.fn();
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
  await act(async () => {
    root.render(createElement(TitleBar));
  });
};

const buttonByLabel = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;

describe("TitleBar on Windows and Linux", () => {
  it("does not let a late initial focus query overwrite a live focus event", async () => {
    let resolve!: (value: boolean) => void;
    windowMocks.isFocused.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderBar();
    await act(async () => {
      for (const handler of focusHandlers) handler({ payload: false });
    });
    expect(
      document.querySelector("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("false");
    await act(async () => resolve(true));
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
    await act(async () => resolve(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it.each(["windows", "linux"])(
    "puts %s captions flush against the right window edge",
    async (platform) => {
      platformState.value = platform;
      await renderBar();
      const bar = document.querySelector("[data-focused]")!;
      expect(
        Number.parseFloat(getComputedStyle(bar).paddingRight),
      ).toBe(0);
    },
  );
  it("renders safely without the native OS or window plugins", async () => {
    platformState.native = false;
    await renderBar();
    expect(document.body.textContent).toContain("mausVoice");
    expect(windowMocks.isMaximized).not.toHaveBeenCalled();
    expect(windowMocks.isFocused).not.toHaveBeenCalled();
    await act(async () => buttonByLabel("Minimize")!.click());
    expect(windowMocks.minimize).not.toHaveBeenCalled();
  });
  it("uses the shared reduced-motion-aware timing for both caption colors", async () => {
    await renderBar();
    expect(
      getComputedStyle(buttonByLabel("Minimize")!)
        .transition.split(",")
        .map((value) => value.trim()),
    ).toEqual([
      "background-color var(--duration-fast) ease",
      "color var(--duration-fast) ease",
    ]);
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

    await act(async () => {
      minimize!.click();
    });
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);

    await act(async () => {
      maximize!.click();
    });
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
    expect(buttonByLabel("Restore")).toBeTruthy();

    await act(async () => {
      close!.click();
    });
    expect(windowMocks.close).toHaveBeenCalledTimes(1);
  });

  it("marks focus state for styling and dims when unfocused", async () => {
    await renderBar();

    const bar = document.querySelector("[data-focused]");
    expect(bar?.getAttribute("data-focused")).toBe("true");

    await act(async () => {
      for (const handler of focusHandlers) {
        handler({ payload: false });
      }
    });
    expect(
      document.querySelector("[data-focused]")?.getAttribute("data-focused"),
    ).toBe("false");
  });

  it("toggles maximize on double click of the drag region", async () => {
    await renderBar();

    const dragRegion = document.querySelector(
      "[data-tauri-drag-region]",
    ) as HTMLElement;
    expect(dragRegion).toBeTruthy();
    await act(async () => {
      dragRegion.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(windowMocks.maximize).toHaveBeenCalled();
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

  it("wires traffic buttons to window actions", async () => {
    await renderBar();

    await act(async () => {
      buttonByLabel("Close")!.click();
    });
    expect(windowMocks.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttonByLabel("Minimize")!.click();
    });
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttonByLabel("Maximize")!.click();
    });
    expect(windowMocks.maximize).toHaveBeenCalledTimes(1);
  });
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
    await act(async () => buttonByLabel(label)!.click());
    expect(showError).toHaveBeenCalledWith(error);
  },
);
