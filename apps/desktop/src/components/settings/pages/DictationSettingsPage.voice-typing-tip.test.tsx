// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../../../theme";
import { INITIAL_APP_STATE } from "../../../state/app.state";
import { INITIAL_LOCAL_STATE } from "../../../state/local.state";
import { getAppState, setAppState } from "../../../store";
import { LOCAL_USER_ID } from "../../../utils/user.utils";
import { VOICE_TYPING_TIP_SNOOZE_MS } from "../../../utils/voice-typing-tip";
import DictationSettingsPage from "./DictationSettingsPage";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

vi.mock("../../../utils/platform.utils", () => ({
  getPlatform: () => "macos",
}));

describe("DictationSettingsPage voice typing tip setting", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  const renderPage = async () => {
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
            { initialEntries: ["/dashboard/settings/dictation"] },
            createElement(DictationSettingsPage),
          ),
        ),
      );
    });
  };

  beforeEach(() => {
    ensureUiHarness();
    setMatchMedia(true);
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
      local: { ...INITIAL_LOCAL_STATE },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("renders the Reminders group and Voice typing tip toggle, reflects snooze and auto-disabled states, and resets cleanly on re-enable", async () => {
    const now = Date.now();
    setAppState((prev) => ({
      ...prev,
      local: {
        ...prev.local,
        voiceTypingTip: {
          ...prev.local.voiceTypingTip,
          enabled: true,
          snoozedUntilMs: now + VOICE_TYPING_TIP_SNOOZE_MS,
        },
      },
    }));

    await renderPage();

    const row = document.getElementById("setting-voice_typing_tip");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Voice typing tip");
    expect(
      document.querySelector('[data-voice-typing-tip-status="snoozed"]'),
    ).not.toBeNull();

    // Simulate auto-disabled after 5 No thanks dismissals
    await act(async () => {
      setAppState((prev) => ({
        ...prev,
        local: {
          ...prev.local,
          voiceTypingTip: {
            enabled: false,
            disabledReason: "auto_dismiss_limit",
            snoozedUntilMs: null,
            noThanksTimestampsMs: [now - 5, now - 4, now - 3, now - 2, now - 1],
            autoDisabledAtMs: now,
            nextVariantIndex: 2,
          },
        },
      }));
    });

    expect(
      document.querySelector('[data-voice-typing-tip-status="auto-disabled"]'),
    ).not.toBeNull();

    const toggle = row?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(toggle?.checked).toBe(false);

    await act(async () => {
      toggle?.click();
    });

    const restored = getAppState().local.voiceTypingTip;
    expect(restored.enabled).toBe(true);
    expect(restored.disabledReason).toBeNull();
    expect(restored.snoozedUntilMs).toBeNull();
    expect(restored.noThanksTimestampsMs).toEqual([]);
    expect(restored.autoDisabledAtMs).toBeNull();
  });
});
