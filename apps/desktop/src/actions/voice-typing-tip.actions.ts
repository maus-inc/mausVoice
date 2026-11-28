import { defineMessage, type IntlShape } from "react-intl";
import { getIntl } from "../i18n/intl";
import type { SettingsState } from "../state/settings.state";
import { getAppState, produceAppState } from "../store";
import type { ToastAction } from "../types/toast.types";
import { navigateApp } from "../utils/app-navigation";
import { getLogger } from "../utils/log.utils";
import {
  VOICE_TYPING_TIP_NO_THANKS_DELAY_MS,
  VOICE_TYPING_TIP_POST_CLOSE_COOLDOWN_MS,
  advanceVoiceTypingTipVariantState,
  formatShortcutComboForDisplay,
  getVoiceTypingTipExclusionReason,
  recordVoiceTypingTipNoThanks,
  resolveVoiceTypingTipReadiness,
  setVoiceTypingTipEnabledState,
  type VoiceTypingTipPromptState,
  type VoiceTypingTipReadiness,
} from "../utils/voice-typing-tip";
import { surfaceMainWindowDetached } from "../utils/window.utils";
import { showSnackbar } from "./app.actions";
import { locatePill } from "./native.actions";
import { dismissToast, runToast, showToast } from "./toast.actions";

const VOICE_TYPING_TIP_PILL_INITIAL_DURATION_MS = 30_000;
const VOICE_TYPING_TIP_PILL_REVEALED_DURATION_MS = 20_000;

const COPY_WITH_SHORTCUT = [
  defineMessage({
    defaultMessage:
      "Typing a longer note? Hold {shortcut} to speak it instead.",
  }),
  defineMessage({
    defaultMessage:
      "Longer reply? Press {shortcut} whenever speaking feels easier.",
  }),
  defineMessage({
    defaultMessage:
      "Drafting at length? {shortcut} lets you dictate right into this field.",
  }),
  defineMessage({
    defaultMessage:
      "Writing a longer passage? {shortcut} is ready when you want to talk it out.",
  }),
] as const;

const COPY_WITHOUT_SHORTCUT = [
  defineMessage({
    defaultMessage: "Typing a longer note? You can speak it instead.",
  }),
  defineMessage({
    defaultMessage:
      "Longer reply? Use voice typing whenever speaking feels easier.",
  }),
  defineMessage({
    defaultMessage:
      "Drafting at length? Voice typing inserts right into this field.",
  }),
  defineMessage({
    defaultMessage:
      "Writing a longer passage? Voice typing is ready when you want to talk it out.",
  }),
] as const;

const AUTO_DISABLED_CONFIRMATION_MESSAGE = defineMessage({
  defaultMessage:
    "Voice-typing tips turned off. You can turn them back on anytime in Settings → Dictation.",
});

const READY_SHORTCUT_CUE_MESSAGE = defineMessage({
  defaultMessage: "Hold {shortcut} in any text field to start voice typing.",
});

export const formatVoiceTypingTipBody = (
  prompt: Pick<VoiceTypingTipPromptState, "variantIndex" | "shortcutCombo">,
  intl: IntlShape = getIntl(),
): string => {
  const index =
    ((prompt.variantIndex % COPY_WITH_SHORTCUT.length) +
      COPY_WITH_SHORTCUT.length) %
    COPY_WITH_SHORTCUT.length;
  const shortcut = formatShortcutComboForDisplay(prompt.shortcutCombo);
  if (shortcut) {
    return intl.formatMessage(COPY_WITH_SHORTCUT[index], { shortcut });
  }
  return intl.formatMessage(COPY_WITHOUT_SHORTCUT[index]);
};

let nextPromptId = 0;
let noThanksRevealTimer: ReturnType<typeof setTimeout> | null = null;
let cooldownListener: ((untilMs: number) => void) | null = null;

const clearNoThanksRevealTimer = (): void => {
  if (noThanksRevealTimer !== null) {
    clearTimeout(noThanksRevealTimer);
    noThanksRevealTimer = null;
  }
};

export const registerVoiceTypingTipCooldownListener = (
  listener: ((untilMs: number) => void) | null,
): void => {
  cooldownListener = listener;
};

const notifyPostCloseCooldown = (nowMs: number): void => {
  cooldownListener?.(nowMs + VOICE_TYPING_TIP_POST_CLOSE_COOLDOWN_MS);
};

export const getVisibleVoiceTypingTipPromptId = (): string | undefined => {
  const active = getAppState().voiceTypingTipPrompt;
  return active ? String(active.id) : undefined;
};

const primaryToastActionForPrompt = (
  prompt: Pick<VoiceTypingTipPromptState, "ctaKind">,
): ToastAction =>
  prompt.ctaKind === "try" ? "voice_typing_tip_try" : "voice_typing_tip_setup";

const sendMirroredPillToast = (
  prompt: VoiceTypingTipPromptState,
  includeNoThanks: boolean,
): void => {
  runToast(
    showToast({
      message: formatVoiceTypingTipBody(prompt),
      toastType: "info",
      duration: includeNoThanks
        ? VOICE_TYPING_TIP_PILL_REVEALED_DURATION_MS
        : VOICE_TYPING_TIP_PILL_INITIAL_DURATION_MS,
      action: primaryToastActionForPrompt(prompt),
      rejectAction: includeNoThanks ? "voice_typing_tip_no_thanks" : undefined,
      proposalId: String(prompt.id),
    }),
  );
};

const scheduleNoThanksReveal = (promptId: number): void => {
  noThanksRevealTimer = setTimeout(() => {
    noThanksRevealTimer = null;
    const current = getAppState().voiceTypingTipPrompt;
    if (!current || current.id !== promptId) {
      return;
    }
    produceAppState((draft) => {
      if (draft.voiceTypingTipPrompt?.id === promptId) {
        draft.voiceTypingTipPrompt.noThanksVisible = true;
      }
    });
    if (current.mirroredOnPill) {
      sendMirroredPillToast(current, true);
    }
  }, VOICE_TYPING_TIP_NO_THANKS_DELAY_MS);
};

export const showVoiceTypingTipPrompt = (options: {
  pathname: string;
  mirrorToPill: boolean;
  nowMs?: number;
}): VoiceTypingTipPromptState | null => {
  const nowMs = options.nowMs ?? Date.now();
  const state = getAppState();
  if (
    state.voiceTypingTipPrompt !== null ||
    getVoiceTypingTipExclusionReason(state, options.pathname, nowMs) !== null
  ) {
    return null;
  }

  const readiness = resolveVoiceTypingTipReadiness(state);
  const { chosenVariantIndex, state: nextTipLocalState } =
    advanceVoiceTypingTipVariantState(state.local.voiceTypingTip, nowMs);

  nextPromptId += 1;
  const prompt: VoiceTypingTipPromptState = {
    id: nextPromptId,
    variantIndex: chosenVariantIndex,
    ctaKind: readiness.status === "ready" ? "try" : "setup",
    shortcutCombo:
      readiness.status === "ready" ? readiness.shortcutCombo : null,
    shownAtMs: nowMs,
    noThanksRevealAtMs: nowMs + VOICE_TYPING_TIP_NO_THANKS_DELAY_MS,
    noThanksVisible: false,
    mirroredOnPill: options.mirrorToPill,
  };

  clearNoThanksRevealTimer();
  produceAppState((draft) => {
    draft.local.voiceTypingTip = nextTipLocalState;
    draft.voiceTypingTipPrompt = prompt;
  });

  if (prompt.mirroredOnPill) {
    sendMirroredPillToast(prompt, false);
  }
  scheduleNoThanksReveal(prompt.id);
  return prompt;
};

export const dismissVoiceTypingTip = (options?: {
  fromPillClick?: boolean;
  applyCooldown?: boolean;
  nowMs?: number;
}): void => {
  const nowMs = options?.nowMs ?? Date.now();
  const active = getAppState().voiceTypingTipPrompt;
  clearNoThanksRevealTimer();
  if (!active) {
    return;
  }

  produceAppState((draft) => {
    draft.voiceTypingTipPrompt = null;
  });

  if (options?.applyCooldown !== false) {
    notifyPostCloseCooldown(nowMs);
  }

  if (active.mirroredOnPill && !options?.fromPillClick) {
    runToast(dismissToast());
  }
};

export const declineVoiceTypingTipWithNoThanks = (options?: {
  fromPillClick?: boolean;
  nowMs?: number;
}): void => {
  const nowMs = options?.nowMs ?? Date.now();
  const state = getAppState();
  const active = state.voiceTypingTipPrompt;
  clearNoThanksRevealTimer();

  const { state: nextTipLocalState, autoDisabledNow } =
    recordVoiceTypingTipNoThanks(state.local.voiceTypingTip, nowMs);

  produceAppState((draft) => {
    draft.voiceTypingTipPrompt = null;
    draft.local.voiceTypingTip = nextTipLocalState;
  });

  if (active?.mirroredOnPill && !options?.fromPillClick) {
    runToast(dismissToast());
  }

  if (!autoDisabledNow) {
    return;
  }

  const message = getIntl().formatMessage(AUTO_DISABLED_CONFIRMATION_MESSAGE);
  showSnackbar(message, { mode: "info", duration: 5_000 });
  if (options?.fromPillClick || active?.mirroredOnPill) {
    runToast(showToast({ message, toastType: "info", duration: 5_000 }));
  }
};

const SETUP_DIALOG_BY_STATUS: Record<
  Exclude<VoiceTypingTipReadiness["status"], "ready" | "needs_onboarding">,
  keyof Pick<
    SettingsState,
    "microphoneDialogOpen" | "aiTranscriptionDialogOpen" | "shortcutsDialogOpen"
  >
> = {
  needs_microphone: "microphoneDialogOpen",
  needs_transcription: "aiTranscriptionDialogOpen",
  needs_shortcut: "shortcutsDialogOpen",
};

const openIncompleteSetupSurface = (
  status: Exclude<VoiceTypingTipReadiness["status"], "ready">,
  shouldSurfaceWindow: boolean,
): void => {
  if (shouldSurfaceWindow) {
    surfaceMainWindowDetached();
  }
  if (status === "needs_onboarding") {
    navigateApp("/onboarding").catch((error: unknown) => {
      getLogger().warning(
        `Failed to open onboarding from voice typing tip: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return;
  }
  const dialogKey = SETUP_DIALOG_BY_STATUS[status];
  produceAppState((draft) => {
    draft.settings[dialogKey] = true;
  });
};

const surfaceReadyVoiceTypingCue = (
  shortcutCombo: readonly string[],
  preferPillToast: boolean,
): void => {
  // Never start unexpected audio capture: highlight/locate the dictation pill
  // and remind the user of their configured shortcut so they start intentionally.
  void locatePill();
  const shortcut = formatShortcutComboForDisplay(shortcutCombo) ?? "";
  const cue = getIntl().formatMessage(READY_SHORTCUT_CUE_MESSAGE, { shortcut });
  if (preferPillToast) {
    runToast(showToast({ message: cue, toastType: "info", duration: 4_500 }));
  } else {
    showSnackbar(cue, { mode: "info", duration: 4_500 });
  }
};

export const acceptVoiceTypingTip = (options?: {
  fromPillClick?: boolean;
  nowMs?: number;
}): void => {
  const nowMs = options?.nowMs ?? Date.now();
  const active = getAppState().voiceTypingTipPrompt;
  clearNoThanksRevealTimer();

  produceAppState((draft) => {
    draft.voiceTypingTipPrompt = null;
  });
  notifyPostCloseCooldown(nowMs);

  const fromPillOrMirrored = Boolean(
    options?.fromPillClick || active?.mirroredOnPill,
  );
  if (active?.mirroredOnPill && !options?.fromPillClick) {
    runToast(dismissToast());
  }

  const readiness = resolveVoiceTypingTipReadiness(getAppState());
  if (readiness.status === "ready") {
    surfaceReadyVoiceTypingCue(readiness.shortcutCombo, fromPillOrMirrored);
    return;
  }
  openIncompleteSetupSurface(readiness.status, fromPillOrMirrored);
};

export const setVoiceTypingTipEnabled = (
  enabled: boolean,
  nowMs: number = Date.now(),
): void => {
  const active = getAppState().voiceTypingTipPrompt;
  if (!enabled) {
    clearNoThanksRevealTimer();
  }

  produceAppState((draft) => {
    draft.local.voiceTypingTip = setVoiceTypingTipEnabledState(
      draft.local.voiceTypingTip,
      enabled,
      nowMs,
    );
    if (!enabled) {
      draft.voiceTypingTipPrompt = null;
    }
  });

  if (!enabled && active?.mirroredOnPill) {
    runToast(dismissToast());
  }
};

export const resetVoiceTypingTipSessionState = (): void => {
  clearNoThanksRevealTimer();
  produceAppState((draft) => {
    draft.voiceTypingTipPrompt = null;
  });
};
