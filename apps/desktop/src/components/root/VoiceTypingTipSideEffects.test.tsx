// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypingTipTargetEligibility } from "@maus-inc/desktop-native-apis";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { INITIAL_LOCAL_STATE } from "../../state/local.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { LOCAL_USER_ID } from "../../utils/user.utils";
import { resetVoiceTypingTipSessionState } from "../../actions/voice-typing-tip.actions";
import type { ToastActionPayload } from "../../types/toast.types";
import { VoiceTypingTipSideEffects } from "./VoiceTypingTipSideEffects";

const mocks = vi.hoisted(() => ({
  checkEligibility: vi.fn<
    () => Promise<
      | { status: "ok"; data: TypingTipTargetEligibility }
      | { status: "error"; data: string }
    >
  >(() => Promise.resolve({ status: "ok", data: "eligible" })),
  windowVisible: true,
  windowFocused: true,
  toastHandler: null as ((payload: ToastActionPayload) => void) | null,
  showToast: vi.fn(() => Promise.resolve()),
  dismissToast: vi.fn(() => Promise.resolve()),
}));

vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: {
    checkTypingTipTargetEligibility: () => mocks.checkEligibility(),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isVisible: () => Promise.resolve(mocks.windowVisible),
    isFocused: () => Promise.resolve(mocks.windowFocused),
  }),
}));

vi.mock("../../hooks/toast.hooks", () => ({
  useToastAction: (cb: (payload: ToastActionPayload) => void) => {
    mocks.toastHandler = cb;
  },
}));

vi.mock("../../actions/toast.actions", () => ({
  showToast: (...args: unknown[]) => mocks.showToast(...(args as [])),
  dismissToast: () => mocks.dismissToast(),
  runToast: (p: Promise<void>) => {
    void p;
  },
}));

vi.mock("../../actions/native.actions", () => ({
  locatePill: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/platform.utils", () => ({
  getPlatform: () => "macos",
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

describe("VoiceTypingTipSideEffects", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;

  const seedReadyStore = () => {
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
      userPrefs: {
        userId: LOCAL_USER_ID,
        dictationPillVisibility: "persistent",
      } as never,
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
      local: { ...INITIAL_LOCAL_STATE },
      voiceTypingTipPrompt: null,
    });
  };

  const mountEffects = async (initialPath = "/dashboard") => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(
          MemoryRouter,
          { initialEntries: [initialPath] },
          createElement(VoiceTypingTipSideEffects),
        ),
      );
    });
  };

  const typeSustainedViaKeysHeld = async () => {
    const keys = [
      "KeyW",
      "KeyR",
      "KeyI",
      "KeyT",
      "KeyI",
      "KeyN",
      "KeyG",
      "Space",
      "KeyN",
      "KeyO",
      "KeyT",
      "KeyE",
    ];
    for (const key of keys) {
      await act(async () => {
        produceAppState((draft) => {
          draft.keysHeld = [key];
        });
        vi.advanceTimersByTime(250);
        produceAppState((draft) => {
          draft.keysHeld = [];
        });
        vi.advanceTimersByTime(250);
      });
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ensureUiHarness();
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    mocks.checkEligibility.mockReset();
    mocks.checkEligibility.mockResolvedValue({
      status: "ok",
      data: "eligible",
    });
    mocks.windowVisible = true;
    mocks.windowFocused = true;
    mocks.toastHandler = null;
    mocks.showToast.mockClear();
    mocks.dismissToast.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    seedReadyStore();
  });

  afterEach(async () => {
    resetVoiceTypingTipSessionState();
    hasFocusSpy.mockRestore();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("triggers on >5s sustained typing in an eligible textarea and auto-clears if dictation starts", async () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    await mountEffects();
    await typeSustainedViaKeysHeld();

    expect(getAppState().voiceTypingTipPrompt).not.toBeNull();

    await act(async () => {
      produceAppState((draft) => {
        draft.activeRecordingMode = "dictate";
      });
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
  });

  it("never triggers when typing in a password field", async () => {
    const pw = document.createElement("input");
    pw.type = "password";
    document.body.appendChild(pw);
    pw.focus();

    await mountEffects();
    await typeSustainedViaKeysHeld();

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
  });

  it("blocks external-window typing when native target eligibility is secure_input, private_context, or unknown", async () => {
    hasFocusSpy.mockReturnValue(false);

    for (const blocked of [
      "secure_input",
      "private_context",
      "not_editable",
      "unknown",
    ] as const) {
      mocks.checkEligibility.mockResolvedValueOnce({
        status: "ok",
        data: blocked,
      });
      await mountEffects();
      await typeSustainedViaKeysHeld();
      expect(getAppState().voiceTypingTipPrompt).toBeNull();
      await act(async () => {
        root?.unmount();
      });
      root = null;
      host?.remove();
      host = null;
    }
  });

  it("mirrors to the persistent pill when the main window is hidden and correlates pill actions by proposalId", async () => {
    hasFocusSpy.mockReturnValue(false);
    mocks.windowVisible = false;
    mocks.windowFocused = false;
    mocks.checkEligibility.mockResolvedValue({
      status: "ok",
      data: "eligible",
    });

    await mountEffects();
    await typeSustainedViaKeysHeld();

    const prompt = getAppState().voiceTypingTipPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.mirroredOnPill).toBe(true);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);

    // Stale proposalId is ignored
    await act(async () => {
      mocks.toastHandler?.({
        action: "voice_typing_tip_no_thanks",
        proposalId: "999999",
      });
    });
    expect(getAppState().voiceTypingTipPrompt).not.toBeNull();

    // Matching proposalId records No thanks snooze
    await act(async () => {
      mocks.toastHandler?.({
        action: "voice_typing_tip_no_thanks",
        proposalId: String(prompt?.id),
      });
    });
    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    expect(getAppState().local.voiceTypingTip.snoozedUntilMs).not.toBeNull();
  });

  it("mirrors to the pill when the main window is visible but not foregrounded", async () => {
    hasFocusSpy.mockReturnValue(false);
    mocks.windowVisible = true;
    mocks.windowFocused = false;
    mocks.checkEligibility.mockResolvedValue({
      status: "ok",
      data: "eligible",
    });

    await mountEffects();
    await typeSustainedViaKeysHeld();

    const prompt = getAppState().voiceTypingTipPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.mirroredOnPill).toBe(true);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it("falls back to webview KeyboardEvent.code when hotkeyStrategy is bridge", async () => {
    hasFocusSpy.mockReturnValue(true);
    mocks.checkEligibility.mockResolvedValue({
      status: "ok",
      data: "unknown",
    });
    produceAppState((draft) => {
      draft.hotkeyStrategy = "bridge";
      draft.keyboardListenerHealth = "healthy_grab";
    });

    const editable = document.createElement("textarea");
    document.body.appendChild(editable);
    editable.focus();

    await mountEffects();

    const codes = [
      "KeyH",
      "KeyE",
      "KeyL",
      "KeyL",
      "KeyO",
      "Space",
      "KeyW",
      "KeyO",
      "KeyR",
    ];
    for (let index = 0; index < codes.length; index += 1) {
      await act(async () => {
        if (index > 0) {
          vi.advanceTimersByTime(700);
        }
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: codes[index],
            bubbles: true,
          }),
        );
      });
    }
    await act(async () => {
      await Promise.resolve();
    });

    expect(getAppState().voiceTypingTipPrompt).not.toBeNull();
    expect(document.activeElement).toBe(editable);
    editable.remove();
  });

  it("drops an in-flight target eligibility probe when unmounted before it resolves", async () => {
    vi.useFakeTimers({ now: 20_000 });

    let resolveProbe:
      | ((value: { status: "ok"; data: TypingTipTargetEligibility }) => void)
      | null = null;
    mocks.checkEligibility.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const editable = document.createElement("textarea");
    document.body.appendChild(editable);
    editable.focus();

    await mountEffects();

    const keys = [
      "KeyH",
      "KeyE",
      "KeyL",
      "KeyL",
      "KeyO",
      "Space",
      "KeyW",
      "KeyO",
      "KeyR",
    ];
    for (let index = 0; index < keys.length; index += 1) {
      await act(async () => {
        if (index > 0) {
          vi.advanceTimersByTime(350);
        }
        produceAppState((draft) => {
          draft.keysHeld = [keys[index]!];
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(350);
        produceAppState((draft) => {
          draft.keysHeld = [];
        });
      });
    }

    expect(mocks.checkEligibility).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
      root = null;
    });

    await act(async () => {
      resolveProbe?.({ status: "ok", data: "eligible" });
      await Promise.resolve();
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    editable.remove();
  });

  it("suppresses the prompt when the native target probe fails", async () => {
    mocks.checkEligibility.mockResolvedValue({
      status: "error",
      data: "ipc unavailable",
    });

    const editable = document.createElement("textarea");
    document.body.appendChild(editable);
    editable.focus();

    await mountEffects();
    await typeSustainedViaKeysHeld();

    expect(mocks.checkEligibility).toHaveBeenCalled();
    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    editable.remove();
  });

  it("drops the verdict when focus moves to a password field during the probe", async () => {
    let resolveProbe:
      | ((value: { status: "ok"; data: TypingTipTargetEligibility }) => void)
      | null = null;
    mocks.checkEligibility.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const editable = document.createElement("textarea");
    document.body.appendChild(editable);
    editable.focus();

    await mountEffects();
    await typeSustainedViaKeysHeld();

    expect(mocks.checkEligibility).toHaveBeenCalledTimes(1);

    const pw = document.createElement("input");
    pw.type = "password";
    document.body.appendChild(pw);
    pw.focus();

    await act(async () => {
      resolveProbe?.({ status: "ok", data: "eligible" });
      await Promise.resolve();
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    editable.remove();
    pw.remove();
  });

  it("clears a visible prompt without cooldown or dismissal history when focus enters a password field", async () => {
    const editable = document.createElement("textarea");
    document.body.appendChild(editable);
    editable.focus();

    await mountEffects();
    await typeSustainedViaKeysHeld();

    expect(getAppState().voiceTypingTipPrompt).not.toBeNull();

    const pw = document.createElement("input");
    pw.type = "password";
    document.body.appendChild(pw);
    await act(async () => {
      pw.focus();
      pw.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(getAppState().voiceTypingTipPrompt).toBeNull();
    expect(getAppState().local.voiceTypingTip.noThanksTimestampsMs).toEqual([]);
    editable.remove();
    pw.remove();
  });
});
