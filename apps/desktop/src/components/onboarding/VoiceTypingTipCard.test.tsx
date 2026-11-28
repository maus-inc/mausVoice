// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { INITIAL_LOCAL_STATE } from "../../state/local.state";
import { LOCAL_USER_ID } from "../../utils/user.utils";
import { getAppState, setAppState } from "../../store";
import {
  resetVoiceTypingTipSessionState,
  setVoiceTypingTipEnabled,
  showVoiceTypingTipPrompt,
} from "../../actions/voice-typing-tip.actions";
import { TipToaster } from "./TipToaster";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

const nativeMocks = vi.hoisted(() => ({
  locatePill: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../actions/native.actions", () => ({
  locatePill: nativeMocks.locatePill,
}));

vi.mock("../../utils/platform.utils", () => ({
  getPlatform: () => "macos",
}));

vi.mock("../../actions/toast.actions", () => ({
  showToast: vi.fn(() => Promise.resolve()),
  dismissToast: vi.fn(() => Promise.resolve()),
  runToast: (p: Promise<void>) => {
    void p;
  },
}));

describe("VoiceTypingTipCard in TipToaster", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  const seedStore = () => {
    setAppState({
      ...INITIAL_APP_STATE,
      initialized: true,
      auth: {
        uid: LOCAL_USER_ID,
        email: null,
        displayName: "Ada",
        providers: [],
      },
      userById: {
        [LOCAL_USER_ID]: {
          id: LOCAL_USER_ID,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          name: "Ada",
          bio: "",
          onboarded: true,
          playInteractionChime: true,
          hasFinishedTutorial: true,
          wordsThisMonth: 0,
          wordsTotal: 0,
        },
      },
      permissions: {
        microphone: {
          kind: "microphone",
          state: "authorized",
          promptShown: true,
        },
        accessibility: {
          kind: "accessibility",
          state: "authorized",
          promptShown: true,
        },
      },
      hotkeyById: {
        hk1: {
          id: "hk1",
          actionName: "dictate",
          keys: ["Function"],
        },
      },
      local: {
        ...INITIAL_LOCAL_STATE,
        dismissedTipIds: [
          "generative-provider",
          "writing-styles",
          "assistant-mode",
          "review-before-insert",
          "update-channel",
        ],
      },
      voiceTypingTipPrompt: null,
    });
  };

  const mountToaster = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(
          ThemeProvider,
          { ...THEME_PROVIDER_CONFIG, theme },
          createElement(
            MemoryRouter,
            { initialEntries: ["/dashboard"] },
            createElement(TipToaster),
          ),
        ),
      );
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ensureUiHarness();
    setMatchMedia(true); // prefers-reduced-motion so exit transitions settle synchronously
    nativeMocks.locatePill.mockClear();
    seedStore();
  });

  afterEach(async () => {
    resetVoiceTypingTipSessionState();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  it("never steals focus, shares the single role=status live region, reveals No thanks at 10s, and snoozes 1h", async () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    await mountToaster();

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 10_000,
      });
    });

    expect(document.activeElement).toBe(editor);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Typing a longer note?",
    );
    expect(
      document.querySelector('[data-voice-typing-tip="true"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-tip-card="true"]')).toBeNull();

    // Hidden before 10 seconds
    expect(
      document.querySelector('[data-voice-typing-tip-no-thanks="true"]'),
    ).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    expect(
      document.querySelector('[data-voice-typing-tip-no-thanks="true"]'),
    ).toBeNull();

    // Revealed at 10 seconds without stealing focus
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const noThanksBtn = document.querySelector<HTMLButtonElement>(
      '[data-voice-typing-tip-no-thanks="true"]',
    );
    expect(noThanksBtn).not.toBeNull();
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      noThanksBtn?.click();
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    expect(getAppState().local.voiceTypingTip.enabled).toBe(true);
    expect(getAppState().local.voiceTypingTip.snoozedUntilMs).not.toBeNull();
    expect(
      getAppState().local.voiceTypingTip.noThanksTimestampsMs,
    ).toHaveLength(1);
    editor.remove();
  });

  it("cancels the 10s reveal timer cleanly when dismissed or disabled before 10s", async () => {
    await mountToaster();

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 20_000,
      });
    });

    const closeBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss voice typing tip"]',
    );
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn?.click();
      vi.advanceTimersByTime(15_000);
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    expect(
      document.querySelector('[data-voice-typing-tip-no-thanks="true"]'),
    ).toBeNull();

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 40_000,
      });
      setVoiceTypingTipEnabled(false, 41_000);
      vi.advanceTimersByTime(15_000);
    });
    expect(getAppState().voiceTypingTipPrompt).toBeNull();
  });

  it("routes primary CTA to locatePill when ready and to setup dialog when incomplete without starting capture", async () => {
    await mountToaster();

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 50_000,
      });
    });

    const primaryReady = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-voice-typing-tip="true"] button',
      ),
    ).find((btn) => btn.textContent?.includes("Try voice typing"));
    expect(primaryReady).not.toBeUndefined();

    await act(async () => {
      primaryReady?.click();
    });

    expect(nativeMocks.locatePill).toHaveBeenCalledTimes(1);
    expect(getAppState().activeRecordingMode).toBeNull();

    // Clear shortcut -> CTA becomes "Set up voice typing" and opens shortcuts dialog
    setAppState((prev) => ({
      ...prev,
      hotkeyById: {
        hk1: {
          id: "hk1",
          actionName: "dictate",
          keys: [],
        },
      },
    }));

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 120_000,
      });
    });

    const primarySetup = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-voice-typing-tip="true"] button',
      ),
    ).find((btn) => btn.textContent?.includes("Set up voice typing"));
    expect(primarySetup).not.toBeUndefined();

    await act(async () => {
      primarySetup?.click();
    });

    expect(getAppState().settings.shortcutsDialogOpen).toBe(true);
    expect(getAppState().activeRecordingMode).toBeNull();
  });

  it("shifts docking to bottom-left when the focused editable element occupies the bottom-right corner", async () => {
    Object.defineProperty(window, "innerWidth", {
      value: 1280,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });

    const bottomRightInput = document.createElement("textarea");
    bottomRightInput.getBoundingClientRect = () =>
      ({
        left: 960,
        right: 1260,
        top: 700,
        bottom: 780,
        width: 300,
        height: 80,
        x: 960,
        y: 700,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(bottomRightInput);
    bottomRightInput.focus();

    await mountToaster();

    await act(async () => {
      showVoiceTypingTipPrompt({
        pathname: "/dashboard",
        mirrorToPill: false,
        nowMs: 10_000,
      });
    });

    expect(
      document.querySelector('[data-voice-typing-tip-dock="bottom-left"]'),
    ).not.toBeNull();
    bottomRightInput.remove();
  });
});
