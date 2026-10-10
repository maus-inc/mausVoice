// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

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

import { ThemeProvider } from "@mui/material/styles";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { SonnerToaster } from "../root/SonnerToaster";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import SettingsPage from "./SettingsPage";

ensureUiHarness();

/**
 * The generative-provider tip's click action must complete the task in
 * place. It opens the Groq key dialog with keyboard focus on its input (the
 * dialog's TextField carries autoFocus), and reveals the Groq row (smooth
 * scroll + highlight) so the user lands there if they close the dialog
 * without saving.
 *
 * The tip itself now renders into sonner's toast layer rather than into
 * `SettingsPage`'s own tree, so this test mounts the real `SonnerToaster`
 * alongside the page, the same pairing `main.tsx` mounts them in. The
 * toaster mounts first, so it has subscribed to the store before the page's
 * mount effect calls `showTipToast`.
 */
describe("generative-provider tip action", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  /** jsdom does not run rAF, so queued frames are driven explicitly. */
  let frames: Array<FrameRequestCallback>;
  /** scrollIntoView calls with their receiver, recorded from the prototype. */
  let scrollCalls: Array<{ el: Element; options?: ScrollIntoViewOptions }>;

  beforeEach(() => {
    // The plain stub this file used before `ThemeProvider` needed it lacks
    // `addListener`/`removeListener`, which MUI's cssVars scheme watcher
    // still calls; the shared harness stub implements the full legacy API.
    setMatchMedia(false);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = () => undefined;
    });
    // jsdom has no layout, so scrollIntoView is absent; the action calls it
    // on the revealed row via requestAnimationFrame.
    scrollCalls = [];
    Element.prototype.scrollIntoView = vi.fn(function (
      this: Element,
      options?: ScrollIntoViewOptions | boolean,
    ) {
      scrollCalls.push({
        el: this,
        options: options as ScrollIntoViewOptions | undefined,
      });
    });
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    // Unmounting clears each tip's toast, and sonner's own dismissal is
    // itself debounced through a `requestAnimationFrame` it schedules on a
    // *module-level* store that outlives this test. Draining now, while
    // this test's rAF stub is still installed, flushes that debounce before
    // the stub is restored, so the next test does not inherit a pending
    // callback queued against sonner's shared store.
    for (let round = 0; round < 5 && frames.length > 0; round += 1) {
      await act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });
    }
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
          ThemeProvider,
          { theme, ...THEME_PROVIDER_CONFIG },
          createElement(Fragment, null, [
            createElement(SonnerToaster, { key: "toaster" }),
            createElement(SettingsPage, { key: "page" }),
          ]),
        ),
      );
    });
    await drainFrames();
  };

  const clickTipAction = async () => {
    // This page also anchors the `update-channel` tip (UpdateChannelSetting
    // further down), so both toasts are on screen at once; find the card by
    // its own title rather than assuming toast stacking order.
    const card = Array.from(
      document.querySelectorAll('[data-tip-toast="true"]'),
    ).find((candidate) =>
      candidate.textContent?.includes("Add an AI provider for polishing"),
    );
    const tipBody = card?.querySelector('[role="button"]');
    expect(tipBody).toBeTruthy();
    await act(() => {
      tipBody?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("opens the Groq key dialog and focuses the key input", async () => {
    await renderPage();
    await clickTipAction();

    // The dialog body copy is unique to the dialog (the row's title shares
    // the "Groq API key" wording).
    const dialogCopy = Array.from(
      document.querySelectorAll("p, span, div"),
    ).some(
      (node) =>
        node.textContent ===
        "Store your Groq API key locally for transcription and AI post processing. The key is encrypted before it is saved.",
    );
    expect(dialogCopy).toBe(true);

    const keyInput = document.querySelector("input[type='password']");
    expect(keyInput).toBeTruthy();
    expect(document.activeElement).toBe(keyInput);
  });

  it("reveals the Groq row with a smooth centered scroll", async () => {
    await renderPage();
    await clickTipAction();
    await drainFrames();

    const row = document.getElementById("setting-groq_api_key");
    expect(row).not.toBeNull();
    expect(
      scrollCalls.some(
        (call) =>
          call.el === row &&
          call.options?.block === "center" &&
          call.options?.behavior === "smooth",
      ),
    ).toBe(true);
  });
});
