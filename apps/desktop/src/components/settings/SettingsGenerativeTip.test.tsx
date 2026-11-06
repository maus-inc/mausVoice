// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { getTipAction } from "../onboarding/tip-actions";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(() => Promise.resolve(null)) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

const platform = vi.hoisted(() => ({ name: "windows" as "windows" | "macos" }));
vi.mock("../../utils/platform.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/platform.utils")>();
  return { ...actual, getPlatform: () => platform.name };
});
vi.mock("../../utils/env.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/env.utils")>();
  return {
    ...actual,
    isWindows: () => platform.name === "windows",
    isMacOS: () => platform.name === "macos",
    isLinux: () => false,
  };
});

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
      messages: {},
    }),
  };
});

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import AiModelsSettingsPage from "./pages/AiModelsSettingsPage";
import { SettingsFocusContext } from "./settings-highlight";

ensureUiHarness();

/**
 * The generative-provider tip floats in the bottom-right stack (TipToaster)
 * and its Add API key action is owned by the page the tip sits on. The page
 * must register the handler on mount, and the handler must complete the task
 * in place: ask the settings layout to reveal the Groq key row (the layout
 * owns the scroll and highlight) and open the key dialog, whose input takes
 * focus once it has entered.
 *
 * The focus helper is injected through `SettingsFocusContext`, so this test
 * pins the page's half of the contract — the key it asks to reveal — while
 * `use-settings-anchor-focus.test.tsx` pins the layout's half (the scroll and
 * the highlight).
 */
describe("AiModels page generative-provider tip action", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  let focusSetting: ReturnType<typeof vi.fn>;
  /** jsdom does not run rAF, so queued frames are driven explicitly. */
  let frames: Array<FrameRequestCallback>;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = () => undefined;
    });
    focusSetting = vi.fn();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = "";
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const drainFrames = async () => {
    await act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
  };

  const renderPage = async () => {
    platform.name = "windows";
    await act(() => {
      root?.render(
        createElement(
          SettingsFocusContext.Provider,
          { value: focusSetting },
          createElement(AiModelsSettingsPage),
        ),
      );
    });
    await drainFrames();
  };

  it("registers the Add API key handler while the page is mounted", async () => {
    await renderPage();

    const handler = getTipAction("generative-provider");
    expect(handler).toBeTypeOf("function");
  });

  it("reveals the Groq key row and opens the focused dialog", async () => {
    await renderPage();

    const handler = getTipAction("generative-provider");
    if (typeof handler !== "function") {
      throw new Error("Generative-provider tip handler is not registered");
    }
    act(() => {
      handler();
    });
    await drainFrames();

    // The layout owns the scroll and the highlight; the page only names the row.
    expect(focusSetting).toHaveBeenCalledWith("groq_api_key");

    // The dialog body copy is unique to the dialog (the row's title shares
    // the "Groq API key" wording).
    const dialogCopy = Array.from(
      document.querySelectorAll("p, span, div"),
    ).some(
      (node) =>
        node.textContent ===
        "Used for transcription and AI post processing. Encrypted and stored on this computer before it is saved.",
    );
    expect(dialogCopy).toBe(true);

    // The dialog content mounts when the enter transition runs, so the field
    // takes focus a beat after open, not synchronously.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const keyInput = document.querySelector("input[type='password']");
    expect(keyInput).toBeTruthy();
    expect(document.activeElement).toBe(keyInput);
  });

  it("unregisters the handler on unmount", async () => {
    await renderPage();
    expect(getTipAction("generative-provider")).toBeTypeOf("function");

    act(() => root?.unmount());
    root = null;

    expect(getTipAction("generative-provider")).toBeUndefined();
  });
});
