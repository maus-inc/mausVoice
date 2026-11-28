// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";

vi.mock("./platform.utils", () => ({
  getPlatform: () => "macos",
}));
import { createAgentRunState } from "../state/agent.state";
import {
  beginSimulatedTypingGuard,
  endSimulatedTypingGuard,
  resetSimulatedTypingGuardForTests,
} from "./simulated-typing-guard";
import {
  INITIAL_VOICE_TYPING_TIP_LOCAL_STATE,
  SustainedTypingDetector,
  VOICE_TYPING_TIP_DISMISS_WINDOW_MS,
  VOICE_TYPING_TIP_SNOOZE_MS,
  advanceVoiceTypingTipVariantState,
  classifyHeldKeysSample,
  classifyWebviewActiveElement,
  doesElementOverlapBottomRightCorner,
  getVoiceTypingTipExclusionReason,
  isVoiceTypingTipSnoozed,
  normalizeVoiceTypingTipLocalState,
  recordVoiceTypingTipNoThanks,
  resolveVoiceTypingTipReadiness,
  setVoiceTypingTipEnabledState,
} from "./voice-typing-tip";
import { LOCAL_USER_ID } from "./user.utils";

const createTestUser = (onboarded = true) => ({
  id: LOCAL_USER_ID,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  name: "Ada",
  bio: "",
  onboarded,
  playInteractionChime: true,
  hasFinishedTutorial: true,
  wordsThisMonth: 0,
  wordsTotal: 0,
});

const createReadyAppState = (overrides?: Partial<AppState>): AppState => ({
  ...INITIAL_APP_STATE,
  initialized: true,
  auth: {
    uid: LOCAL_USER_ID,
    email: null,
    displayName: "Ada",
    providers: [],
  },
  userById: {
    [LOCAL_USER_ID]: createTestUser(true),
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
  ...overrides,
});

afterEach(() => {
  resetSimulatedTypingGuardForTests();
  document.body.innerHTML = "";
});

describe("SustainedTypingDetector", () => {
  it("requires strictly > 5000ms of continuous prose key transitions (>= 8 keys)", () => {
    const detector = new SustainedTypingDetector();
    const keys = [
      "KeyT",
      "KeyH",
      "KeyI",
      "KeyS",
      "Space",
      "KeyI",
      "KeyS",
      "Space",
      "KeyA",
      "Space",
      "KeyN",
      "KeyO",
    ];

    let t = 1_000;
    let triggeredAt: number | null = null;
    for (const key of keys) {
      const down = detector.onHeldKeysChange([key], [["Function"]], t);
      detector.onHeldKeysChange([], [["Function"]], t + 40);
      if (down.readyToTrigger && triggeredAt === null) {
        triggeredAt = t;
      }
      t += 500;
    }

    // Started at 1000ms; t=6000ms is exactly 5000ms elapsed (not >5000), so
    // t=6500ms (5500ms elapsed, 12 transitions) is the first trigger point.
    expect(triggeredAt).toBe(6_500);
  });

  it("does not trigger at <= 5000ms or when holding a single key down", () => {
    const detector = new SustainedTypingDetector();
    expect(detector.onHeldKeysChange(["KeyA"], [], 1_000).readyToTrigger).toBe(
      false,
    );
    // Holding KeyA down without new key transitions never inflates keystrokes.
    expect(detector.onHeldKeysChange(["KeyA"], [], 7_000).readyToTrigger).toBe(
      false,
    );
  });

  it("resets when the inter-key pause exceeds 1800ms", () => {
    const detector = new SustainedTypingDetector();
    let t = 1_000;
    for (let i = 0; i < 6; i += 1) {
      detector.onHeldKeysChange(["KeyA"], [], t);
      detector.onHeldKeysChange([], [], t + 20);
      t += 600;
    }
    // Pause 2500ms -> burst resets; next keys start a fresh timer.
    t += 2_500;
    const afterPause = detector.onHeldKeysChange(["KeyB"], [], t);
    expect(afterPause.readyToTrigger).toBe(false);
    expect(afterPause.qualifyingTransitions).toBe(1);
    expect(afterPause.elapsedMs).toBe(0);
  });

  it("allows Shift capitalization while resetting on Ctrl/Meta/Alt/Fn chords, navigation keys, and configured hotkeys", () => {
    expect(classifyHeldKeysSample(["ShiftLeft", "KeyH"], [])).toEqual({
      kind: "prose",
      proseKeys: ["KeyH"],
    });
    expect(classifyHeldKeysSample(["ControlLeft", "KeyC"], [])).toEqual({
      kind: "reset",
    });
    expect(classifyHeldKeysSample(["MetaLeft", "KeyV"], [])).toEqual({
      kind: "reset",
    });
    expect(classifyHeldKeysSample(["Escape"], [])).toEqual({ kind: "reset" });
    expect(classifyHeldKeysSample(["DownArrow"], [])).toEqual({
      kind: "reset",
    });
    expect(classifyHeldKeysSample(["KeyD"], [["KeyD"]])).toEqual({
      kind: "reset",
    });
  });

  it("ignores KeyboardEvent auto-repeat in discrete fallback mode and honors post-close cooldown", () => {
    const detector = new SustainedTypingDetector();
    detector.applyCooldown(900);
    expect(detector.onHeldKeysChange(["KeyA"], [], 800).readyToTrigger).toBe(
      false,
    );

    detector.onDiscreteKeyDown(
      "KeyA",
      {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
      },
      [],
      1_000,
    );
    for (let t = 1_500; t <= 7_000; t += 500) {
      const res = detector.onDiscreteKeyDown(
        "KeyA",
        {
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          repeat: true,
        },
        [],
        t,
      );
      expect(res.readyToTrigger).toBe(false);
    }
  });
});

describe("classifyWebviewActiveElement", () => {
  it("classifies prose inputs as eligible without reading .value", () => {
    const input = document.createElement("input");
    input.type = "text";
    let valueRead = false;
    Object.defineProperty(input, "value", {
      get() {
        valueRead = true;
        return "super-secret";
      },
    });
    document.body.appendChild(input);

    expect(classifyWebviewActiveElement(input)).toBe("eligible");
    expect(valueRead).toBe(false);

    const textarea = document.createElement("textarea");
    expect(classifyWebviewActiveElement(textarea)).toBe("eligible");

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(classifyWebviewActiveElement(editable)).toBe("eligible");
  });

  it("blocks password, OTP, credit-card, password-manager-ignored, and masked inputs", () => {
    const pw = document.createElement("input");
    pw.type = "password";
    expect(classifyWebviewActiveElement(pw)).toBe("secure_input");

    const otp = document.createElement("input");
    otp.type = "text";
    otp.setAttribute("autocomplete", "section-login one-time-code");
    expect(classifyWebviewActiveElement(otp)).toBe("secure_input");

    const apiField = document.createElement("input");
    apiField.type = "text";
    apiField.setAttribute("data-1p-ignore", "");
    expect(classifyWebviewActiveElement(apiField)).toBe("secure_input");

    const masked = document.createElement("input");
    masked.type = "text";
    masked.setAttribute("style", "-webkit-text-security: disc;");
    expect(classifyWebviewActiveElement(masked)).toBe("secure_input");

    const readOnly = document.createElement("textarea");
    readOnly.readOnly = true;
    expect(classifyWebviewActiveElement(readOnly)).toBe("not_editable");
  });

  it("treats class-based text masking as secure through the computed style", () => {
    const maskedByClass = document.createElement("input");
    maskedByClass.type = "text";
    maskedByClass.className = "masked-field";

    const computedSpy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (property: string) =>
        property === "-webkit-text-security" ? "disc" : "",
    } as CSSStyleDeclaration);
    expect(classifyWebviewActiveElement(maskedByClass)).toBe("secure_input");

    computedSpy.mockReturnValue({
      getPropertyValue: (property: string) =>
        property === "-webkit-text-security" ? "none" : "",
    } as CSSStyleDeclaration);
    expect(classifyWebviewActiveElement(maskedByClass)).toBe("eligible");
    computedSpy.mockRestore();
  });
});

describe("snooze, rolling 7-day auto-opt-out, and clock-skew normalization", () => {
  it("snoozes for 1 hour on each of the first 4 No thanks clicks and auto-disables on the 5th within 7 days", () => {
    const t0 = 1_700_000_000_000;
    let state = INITIAL_VOICE_TYPING_TIP_LOCAL_STATE;

    for (let i = 0; i < 4; i += 1) {
      const clickAt = t0 + i * 2 * VOICE_TYPING_TIP_SNOOZE_MS;
      const outcome = recordVoiceTypingTipNoThanks(state, clickAt);
      expect(outcome.autoDisabledNow).toBe(false);
      expect(outcome.state.enabled).toBe(true);
      expect(outcome.state.snoozedUntilMs).toBe(
        clickAt + VOICE_TYPING_TIP_SNOOZE_MS,
      );
      expect(isVoiceTypingTipSnoozed(outcome.state, clickAt + 60_000)).toBe(
        true,
      );
      expect(
        isVoiceTypingTipSnoozed(
          outcome.state,
          clickAt + VOICE_TYPING_TIP_SNOOZE_MS,
        ),
      ).toBe(false);
      state = outcome.state;
    }

    const fifthAt = t0 + 8 * VOICE_TYPING_TIP_SNOOZE_MS;
    const fifth = recordVoiceTypingTipNoThanks(state, fifthAt);
    expect(fifth.autoDisabledNow).toBe(true);
    expect(fifth.state.enabled).toBe(false);
    expect(fifth.state.disabledReason).toBe("auto_dismiss_limit");
    expect(fifth.state.autoDisabledAtMs).toBe(fifthAt);
    expect(fifth.state.snoozedUntilMs).toBeNull();
  });

  it("drops dismissals older than 7 days so 4 recent + 1 expired does not auto-disable", () => {
    const t0 = 1_700_000_000_000;
    let state = recordVoiceTypingTipNoThanks(
      INITIAL_VOICE_TYPING_TIP_LOCAL_STATE,
      t0,
    ).state;

    const afterSevenDays = t0 + VOICE_TYPING_TIP_DISMISS_WINDOW_MS + 1_000;
    for (let i = 0; i < 4; i += 1) {
      const res = recordVoiceTypingTipNoThanks(
        state,
        afterSevenDays + i * 10_000,
      );
      expect(res.autoDisabledNow).toBe(false);
      expect(res.state.enabled).toBe(true);
      state = res.state;
    }
    expect(state.noThanksTimestampsMs).toHaveLength(4);
  });

  it("clamps future-skewed timestamps and resets cleanly when manually re-enabled", () => {
    const now = 1_700_000_000_000;
    const skewed = normalizeVoiceTypingTipLocalState(
      {
        enabled: true,
        disabledReason: null,
        snoozedUntilMs: now + 365 * 24 * 3_600_000,
        noThanksTimestampsMs: [now + 999_999_999],
        autoDisabledAtMs: null,
        nextVariantIndex: -3,
      },
      now,
    );
    expect(skewed.snoozedUntilMs).toBe(now + VOICE_TYPING_TIP_SNOOZE_MS);
    expect(skewed.noThanksTimestampsMs).toEqual([now]);
    expect(skewed.nextVariantIndex).toBe(1);

    const reenabled = setVoiceTypingTipEnabledState(
      {
        enabled: false,
        disabledReason: "auto_dismiss_limit",
        snoozedUntilMs: null,
        noThanksTimestampsMs: [now - 1000, now - 500],
        autoDisabledAtMs: now - 500,
        nextVariantIndex: 2,
      },
      true,
      now,
    );
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.disabledReason).toBeNull();
    expect(reenabled.noThanksTimestampsMs).toEqual([]);
    expect(reenabled.autoDisabledAtMs).toBeNull();
    expect(reenabled.nextVariantIndex).toBe(2);
  });

  it("rotates across all 4 copy variants deterministically", () => {
    let state = INITIAL_VOICE_TYPING_TIP_LOCAL_STATE;
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const next = advanceVoiceTypingTipVariantState(state, 1_000);
      seen.push(next.chosenVariantIndex);
      state = next.state;
    }
    expect(seen).toEqual([0, 1, 2, 3, 0]);
  });
});

describe("exclusions, readiness, and corner collision", () => {
  it("suppresses during onboarding/auth routes, sensitive dialogs, incognito, active recording/review/assistant, and simulated typing", () => {
    const base = createReadyAppState();
    expect(
      getVoiceTypingTipExclusionReason(base, "/dashboard", 1_000),
    ).toBeNull();

    expect(getVoiceTypingTipExclusionReason(base, "/onboarding", 1_000)).toBe(
      "auth_or_onboarding_route",
    );
    expect(getVoiceTypingTipExclusionReason(base, "/login", 1_000)).toBe(
      "auth_or_onboarding_route",
    );
    expect(
      getVoiceTypingTipExclusionReason(
        { ...base, isRecordingHotkey: true },
        "/dashboard",
        1_000,
      ),
    ).toBe("recording_hotkey");
    expect(
      getVoiceTypingTipExclusionReason(
        {
          ...base,
          settings: { ...base.settings, aiTranscriptionDialogOpen: true },
        },
        "/dashboard",
        1_000,
      ),
    ).toBe("sensitive_dialog");
    expect(
      getVoiceTypingTipExclusionReason(
        { ...base, local: { ...base.local, ephemeralSessionActive: true } },
        "/dashboard",
        1_000,
      ),
    ).toBe("incognito");
    expect(
      getVoiceTypingTipExclusionReason(
        { ...base, activeRecordingMode: "dictate" },
        "/dashboard",
        1_000,
      ),
    ).toBe("active_dictation_or_overlay");
    expect(
      getVoiceTypingTipExclusionReason(
        { ...base, pendingPillReview: { id: "r1", text: "hello" } },
        "/dashboard",
        1_000,
      ),
    ).toBe("pending_review");
    expect(
      getVoiceTypingTipExclusionReason(
        {
          ...base,
          agentStateByConversationId: {
            c1: { ...createAgentRunState("assistant"), status: "calling-llm" },
          },
        },
        "/dashboard",
        1_000,
      ),
    ).toBe("assistant_active");

    beginSimulatedTypingGuard();
    expect(getVoiceTypingTipExclusionReason(base, "/dashboard", 2_000)).toBe(
      "simulated_typing",
    );
    endSimulatedTypingGuard(2_000);
    expect(getVoiceTypingTipExclusionReason(base, "/dashboard", 2_200)).toBe(
      "simulated_typing",
    );
    expect(
      getVoiceTypingTipExclusionReason(base, "/dashboard", 2_500),
    ).toBeNull();
  });

  it("resolves setup readiness without starting audio capture", () => {
    const ready = createReadyAppState();
    expect(resolveVoiceTypingTipReadiness(ready)).toEqual({
      status: "ready",
      shortcutCombo: ["Function"],
    });

    const unonboarded = createReadyAppState({
      userById: {
        [LOCAL_USER_ID]: createTestUser(false),
      },
    });
    expect(resolveVoiceTypingTipReadiness(unonboarded)).toEqual({
      status: "needs_onboarding",
    });

    const clearedShortcut = createReadyAppState({
      hotkeyById: {
        hk1: {
          id: "hk1",
          actionName: "dictate",
          keys: [],
        },
      },
    });
    expect(resolveVoiceTypingTipReadiness(clearedShortcut)).toEqual({
      status: "needs_shortcut",
    });
  });

  it("detects bottom-right corner overlap for focused text fields", () => {
    expect(
      doesElementOverlapBottomRightCorner(
        {
          left: 920,
          right: 1240,
          top: 680,
          bottom: 760,
          width: 320,
          height: 80,
        },
        1280,
        800,
      ),
    ).toBe(true);

    expect(
      doesElementOverlapBottomRightCorner(
        {
          left: 80,
          right: 520,
          top: 120,
          bottom: 240,
          width: 440,
          height: 120,
        },
        1280,
        800,
      ),
    ).toBe(false);
  });
});
