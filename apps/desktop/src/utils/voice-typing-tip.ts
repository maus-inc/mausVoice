import type { AppState } from "../state/app.state";
import {
  isLocalTranscriptionModelSelectable,
  type SettingsState,
} from "../state/settings.state";
import {
  INITIAL_VOICE_TYPING_TIP_LOCAL_STATE,
  VOICE_TYPING_TIP_AUTO_DISABLE_THRESHOLD,
  VOICE_TYPING_TIP_COPY_VARIANT_COUNT,
  VOICE_TYPING_TIP_DISMISS_WINDOW_MS,
  VOICE_TYPING_TIP_MAX_GAP_MS,
  VOICE_TYPING_TIP_MIN_BURST_MS,
  VOICE_TYPING_TIP_MIN_KEYSTROKES,
  VOICE_TYPING_TIP_NO_THANKS_DELAY_MS,
  VOICE_TYPING_TIP_POST_CLOSE_COOLDOWN_MS,
  VOICE_TYPING_TIP_SNOOZE_MS,
  normalizeVoiceTypingTipLocalState,
  type VoiceTypingTipLocalState,
  type VoiceTypingTipPromptState,
} from "../state/voice-typing-tip.state";
import {
  ADD_TO_DICTIONARY_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  OPEN_CHAT_HOTKEY,
  getAdditionalLanguageEntries,
  getHotkeyCombosForAction,
  getPrettyKeyName,
  getSwitchToStyleEntries,
} from "./keyboard.utils";
import {
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModel,
} from "./local-transcription.utils";
import { isPermissionAuthorized } from "./permission.utils";
import { getPlatform } from "./platform.utils";
import { isSimulatedTypingSuppressed } from "./simulated-typing-guard";
import { getMyUser, getTranscriptionPrefs } from "./user.utils";

export {
  INITIAL_VOICE_TYPING_TIP_LOCAL_STATE,
  VOICE_TYPING_TIP_DISMISS_WINDOW_MS,
  VOICE_TYPING_TIP_NO_THANKS_DELAY_MS,
  VOICE_TYPING_TIP_POST_CLOSE_COOLDOWN_MS,
  VOICE_TYPING_TIP_SNOOZE_MS,
  normalizeVoiceTypingTipLocalState,
  type VoiceTypingTipLocalState,
  type VoiceTypingTipPromptState,
};

export const isVoiceTypingTipSnoozed = (
  tipState: VoiceTypingTipLocalState,
  nowMs: number = Date.now(),
): boolean => {
  return getVoiceTypingTipSnoozeRemainingMs(tipState, nowMs) > 0;
};

export const getVoiceTypingTipSnoozeRemainingMs = (
  tipState: VoiceTypingTipLocalState,
  nowMs: number = Date.now(),
): number => {
  if (!tipState.enabled || tipState.snoozedUntilMs === null) {
    return 0;
  }
  const clampedUntil = Math.min(
    tipState.snoozedUntilMs,
    nowMs + VOICE_TYPING_TIP_SNOOZE_MS,
  );
  return Math.max(0, clampedUntil - nowMs);
};

export type RecordNoThanksOutcome = {
  state: VoiceTypingTipLocalState;
  autoDisabledNow: boolean;
};

export const recordVoiceTypingTipNoThanks = (
  previous: VoiceTypingTipLocalState,
  nowMs: number = Date.now(),
): RecordNoThanksOutcome => {
  const normalized = normalizeVoiceTypingTipLocalState(previous, nowMs);
  const windowStartMs = nowMs - VOICE_TYPING_TIP_DISMISS_WINDOW_MS;
  const recent = [
    ...normalized.noThanksTimestampsMs.filter((ts) => ts > windowStartMs),
    nowMs,
  ].slice(-VOICE_TYPING_TIP_AUTO_DISABLE_THRESHOLD);

  if (recent.length >= VOICE_TYPING_TIP_AUTO_DISABLE_THRESHOLD) {
    return {
      state: {
        ...normalized,
        enabled: false,
        disabledReason: "auto_dismiss_limit",
        snoozedUntilMs: null,
        noThanksTimestampsMs: recent,
        autoDisabledAtMs: nowMs,
      },
      autoDisabledNow: true,
    };
  }

  return {
    state: {
      ...normalized,
      enabled: true,
      disabledReason: null,
      snoozedUntilMs: nowMs + VOICE_TYPING_TIP_SNOOZE_MS,
      noThanksTimestampsMs: recent,
      autoDisabledAtMs: null,
    },
    autoDisabledNow: false,
  };
};

export const setVoiceTypingTipEnabledState = (
  previous: VoiceTypingTipLocalState,
  enabled: boolean,
  nowMs: number = Date.now(),
): VoiceTypingTipLocalState => {
  const normalized = normalizeVoiceTypingTipLocalState(previous, nowMs);
  if (enabled) {
    return {
      ...normalized,
      enabled: true,
      disabledReason: null,
      snoozedUntilMs: null,
      noThanksTimestampsMs: [],
      autoDisabledAtMs: null,
    };
  }
  return {
    ...normalized,
    enabled: false,
    disabledReason: "manual",
    snoozedUntilMs: null,
    autoDisabledAtMs: null,
  };
};

export const advanceVoiceTypingTipVariantState = (
  previous: VoiceTypingTipLocalState,
  nowMs: number = Date.now(),
): { state: VoiceTypingTipLocalState; chosenVariantIndex: number } => {
  const normalized = normalizeVoiceTypingTipLocalState(previous, nowMs);
  const chosenVariantIndex = normalized.nextVariantIndex;
  return {
    chosenVariantIndex,
    state: {
      ...normalized,
      nextVariantIndex:
        (chosenVariantIndex + 1) % VOICE_TYPING_TIP_COPY_VARIANT_COUNT,
    },
  };
};

const PROSE_PUNCTUATION_KEYS = new Set([
  "Space",
  "Backspace",
  "Return",
  "KpReturn",
  "Comma",
  "Dot",
  "Slash",
  "SemiColon",
  "Quote",
  "Minus",
  "Equal",
  "LeftBracket",
  "RightBracket",
  "BackSlash",
  "BackQuote",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "Kp0",
  "Kp1",
  "Kp2",
  "Kp3",
  "Kp4",
  "Kp5",
  "Kp6",
  "Kp7",
  "Kp8",
  "Kp9",
  "KpDecimal",
  "KpPlus",
  "KpMinus",
  "KpMultiply",
  "KpDivide",
  "KpEqual",
]);

const isShiftModifierKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return lower === "shift" || lower === "shiftleft" || lower === "shiftright";
};

const isCommandChordModifierKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("control") ||
    lower.startsWith("meta") ||
    lower.startsWith("alt") ||
    lower.startsWith("option") ||
    lower.startsWith("function") ||
    lower === "super"
  );
};

const isProseTypingKey = (key: string): boolean => {
  if (/^Key[A-Z]$/.test(key)) return true;
  if (/^Num[0-9]$/.test(key)) return true;
  return PROSE_PUNCTUATION_KEYS.has(key);
};

const normalizeComboKey = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower.startsWith("shift")) return "shift";
  if (lower.startsWith("control")) return "control";
  if (lower.startsWith("meta")) return "meta";
  if (lower === "alt" || lower === "altleft" || lower.startsWith("option")) {
    return "alt";
  }
  if (lower.startsWith("function")) return "function";
  return lower;
};

const matchesAnyConfiguredCombo = (
  heldKeys: readonly string[],
  configuredCombos: readonly (readonly string[])[],
): boolean => {
  if (heldKeys.length === 0 || configuredCombos.length === 0) {
    return false;
  }
  const heldNormalized = new Set(heldKeys.map(normalizeComboKey));
  return configuredCombos.some((combo) => {
    if (combo.length === 0 || combo.length !== heldNormalized.size) {
      return false;
    }
    return combo.every((key) => heldNormalized.has(normalizeComboKey(key)));
  });
};

export const collectConfiguredHotkeyCombos = (state: AppState): string[][] => {
  const combos: string[][] = [
    ...getHotkeyCombosForAction(state, DICTATE_HOTKEY),
    ...getHotkeyCombosForAction(state, AGENT_DICTATE_HOTKEY),
    ...getHotkeyCombosForAction(state, CANCEL_TRANSCRIPTION_HOTKEY),
    ...getHotkeyCombosForAction(state, OPEN_CHAT_HOTKEY),
    ...getHotkeyCombosForAction(state, ADD_TO_DICTIONARY_HOTKEY),
  ];

  for (const entry of getAdditionalLanguageEntries(state)) {
    combos.push(...entry.hotkeyCombos);
  }
  for (const entry of getSwitchToStyleEntries(state)) {
    combos.push(...entry.hotkeyCombos);
  }
  return combos.filter((combo) => combo.length > 0);
};

export type HeldSampleVerdict =
  { kind: "reset" } | { kind: "prose"; proseKeys: string[] };

export const classifyHeldKeysSample = (
  heldKeys: readonly string[],
  configuredCombos: readonly (readonly string[])[],
): HeldSampleVerdict => {
  if (matchesAnyConfiguredCombo(heldKeys, configuredCombos)) {
    return { kind: "reset" };
  }

  const proseKeys: string[] = [];
  for (const key of heldKeys) {
    if (isShiftModifierKey(key)) {
      continue;
    }
    if (isCommandChordModifierKey(key) || !isProseTypingKey(key)) {
      return { kind: "reset" };
    }
    proseKeys.push(key);
  }

  return { kind: "prose", proseKeys };
};

export type SustainedTypingProgress = {
  readyToTrigger: boolean;
  elapsedMs: number;
  qualifyingTransitions: number;
};

type DiscreteKeyModifiers = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};

const buildDiscreteHeldKeys = (
  rdevKey: string,
  options: DiscreteKeyModifiers,
): string[] => {
  const held: string[] = [];
  if (options.ctrlKey) held.push("ControlLeft");
  if (options.metaKey) held.push("MetaLeft");
  if (options.altKey) held.push("AltLeft");
  if (options.shiftKey && !isShiftModifierKey(rdevKey)) {
    held.push("ShiftLeft");
  }
  held.push(rdevKey);
  return held;
};

const EMPTY_PROGRESS: SustainedTypingProgress = {
  readyToTrigger: false,
  elapsedMs: 0,
  qualifyingTransitions: 0,
};

/**
 * Tracks continuous prose key transitions without inspecting any typed character
 * or field contents. Requires strictly `> 5000ms` of continuous typing with at
 * least 8 distinct key transitions and inter-key gaps `<= 1800ms`.
 */
export class SustainedTypingDetector {
  private burstStartedAtMs: number | null = null;
  private lastTransitionAtMs: number | null = null;
  private qualifyingTransitions = 0;
  private previousProseKeys = new Set<string>();
  private cooldownUntilMs = 0;

  reset(): void {
    this.burstStartedAtMs = null;
    this.lastTransitionAtMs = null;
    this.qualifyingTransitions = 0;
    this.previousProseKeys.clear();
  }

  applyCooldown(untilMs: number): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, untilMs);
    this.reset();
  }

  private currentProgress(nowMs: number): SustainedTypingProgress {
    const elapsedMs =
      this.burstStartedAtMs !== null ? nowMs - this.burstStartedAtMs : 0;
    return {
      readyToTrigger: false,
      elapsedMs,
      qualifyingTransitions: this.qualifyingTransitions,
    };
  }

  private hasGapExpired(nowMs: number): boolean {
    return (
      this.lastTransitionAtMs !== null &&
      nowMs - this.lastTransitionAtMs > VOICE_TYPING_TIP_MAX_GAP_MS
    );
  }

  private recordProseTransitions(
    transitionCount: number,
    nowMs: number,
  ): SustainedTypingProgress {
    if (nowMs < this.cooldownUntilMs) {
      this.burstStartedAtMs = null;
      this.lastTransitionAtMs = null;
      this.qualifyingTransitions = 0;
      return EMPTY_PROGRESS;
    }

    if (transitionCount <= 0) {
      if (this.hasGapExpired(nowMs)) {
        this.burstStartedAtMs = null;
        this.lastTransitionAtMs = null;
        this.qualifyingTransitions = 0;
      }
      return this.currentProgress(nowMs);
    }

    if (this.burstStartedAtMs === null || this.hasGapExpired(nowMs)) {
      this.burstStartedAtMs = nowMs;
      this.lastTransitionAtMs = nowMs;
      this.qualifyingTransitions = transitionCount;
      return {
        readyToTrigger: false,
        elapsedMs: 0,
        qualifyingTransitions: this.qualifyingTransitions,
      };
    }

    this.lastTransitionAtMs = nowMs;
    this.qualifyingTransitions += transitionCount;
    const elapsedMs = nowMs - this.burstStartedAtMs;
    return {
      readyToTrigger:
        elapsedMs > VOICE_TYPING_TIP_MIN_BURST_MS &&
        this.qualifyingTransitions >= VOICE_TYPING_TIP_MIN_KEYSTROKES,
      elapsedMs,
      qualifyingTransitions: this.qualifyingTransitions,
    };
  }

  onHeldKeysChange(
    heldKeys: readonly string[],
    configuredCombos: readonly (readonly string[])[],
    nowMs: number,
  ): SustainedTypingProgress {
    const verdict = classifyHeldKeysSample(heldKeys, configuredCombos);
    if (verdict.kind === "reset") {
      this.reset();
      return EMPTY_PROGRESS;
    }

    const currentProseKeys = new Set(verdict.proseKeys);
    let newlyPressed = 0;
    for (const key of currentProseKeys) {
      if (!this.previousProseKeys.has(key)) {
        newlyPressed += 1;
      }
    }
    this.previousProseKeys = currentProseKeys;
    return this.recordProseTransitions(newlyPressed, nowMs);
  }

  onDiscreteKeyDown(
    rdevKey: string,
    options: DiscreteKeyModifiers,
    configuredCombos: readonly (readonly string[])[],
    nowMs: number,
  ): SustainedTypingProgress {
    if (options.repeat) {
      return this.currentProgress(nowMs);
    }

    const held = buildDiscreteHeldKeys(rdevKey, options);
    const hasChordModifier =
      options.ctrlKey || options.metaKey || options.altKey;
    if (hasChordModifier || matchesAnyConfiguredCombo(held, configuredCombos)) {
      this.reset();
      return EMPTY_PROGRESS;
    }

    if (isShiftModifierKey(rdevKey)) {
      return this.currentProgress(nowMs);
    }

    if (isCommandChordModifierKey(rdevKey) || !isProseTypingKey(rdevKey)) {
      this.reset();
      return EMPTY_PROGRESS;
    }

    return this.recordProseTransitions(1, nowMs);
  }
}

const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

const PROSE_HTML_INPUT_TYPES = new Set(["", "text", "search", "email", "url"]);

const SENSITIVE_DATA_ATTRIBUTES = [
  "data-1p-ignore",
  "data-lpignore",
  "data-bwignore",
  "data-protonpass-ignore",
] as const;

export type WebviewFocusClassification =
  "eligible" | "secure_input" | "not_editable";

const hasMaskedTextSecurity = (element: HTMLElement): boolean => {
  const inlineStyle = element.getAttribute("style")?.toLowerCase() ?? "";
  if (!inlineStyle.includes("text-security")) {
    return false;
  }
  return (
    !inlineStyle.includes("text-security: none") &&
    !inlineStyle.includes("text-security:none")
  );
};

const hasSensitiveElementAttributes = (element: HTMLElement): boolean => {
  if (element.getAttribute("data-sensitive") === "true") {
    return true;
  }
  if (SENSITIVE_DATA_ATTRIBUTES.some((attr) => element.hasAttribute(attr))) {
    return true;
  }
  const autocomplete = (element.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  if (autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token))) {
    return true;
  }
  return hasMaskedTextSecurity(element);
};

const classifyHtmlInput = (
  input: HTMLInputElement,
): WebviewFocusClassification => {
  const rawType = (input.getAttribute("type") ?? input.type ?? "text")
    .trim()
    .toLowerCase();
  if (rawType === "password") {
    return "secure_input";
  }
  if (input.disabled || input.readOnly) {
    return "not_editable";
  }
  return PROSE_HTML_INPUT_TYPES.has(rawType) ? "eligible" : "not_editable";
};

const isRichEditableElement = (element: HTMLElement): boolean => {
  if (element.isContentEditable || element.getAttribute("role") === "textbox") {
    return true;
  }
  const attr = element.getAttribute("contenteditable")?.trim().toLowerCase();
  return attr === "" || attr === "true" || attr === "plaintext-only";
};

/**
 * Classifies the webview's own `document.activeElement` using structural DOM
 * metadata only — never reading `.value`, `.textContent`, or selection ranges.
 */
export const classifyWebviewActiveElement = (
  activeElement: Element | null | undefined,
): WebviewFocusClassification => {
  if (!activeElement || !(activeElement instanceof HTMLElement)) {
    return "not_editable";
  }
  if (hasSensitiveElementAttributes(activeElement)) {
    return "secure_input";
  }
  if (activeElement instanceof HTMLInputElement) {
    return classifyHtmlInput(activeElement);
  }
  if (activeElement instanceof HTMLTextAreaElement) {
    return activeElement.disabled || activeElement.readOnly
      ? "not_editable"
      : "eligible";
  }
  if (!isRichEditableElement(activeElement)) {
    return "not_editable";
  }
  const ariaBlocked =
    activeElement.getAttribute("aria-readonly") === "true" ||
    activeElement.getAttribute("aria-disabled") === "true";
  return ariaBlocked ? "not_editable" : "eligible";
};

const SENSITIVE_SETTINGS_DIALOG_KEYS: readonly (keyof SettingsState)[] = [
  "changePasswordDialogOpen",
  "deleteAccountDialog",
  "clearLocalDataDialogOpen",
  "aiTranscriptionDialogOpen",
  "aiPostProcessingDialogOpen",
  "agentModeDialogOpen",
  "shortcutsDialogOpen",
  "styleHotkeysDialogOpen",
  "appKeybindingsDialogOpen",
  "elevationDeclinedDialogOpen",
];

const EXCLUDED_ROUTE_PREFIXES = [
  "/welcome",
  "/login",
  "/onboarding",
  "/composer",
] as const;

const isExcludedRoute = (pathname: string): boolean => {
  const cleanPath = pathname.trim().toLowerCase();
  return EXCLUDED_ROUTE_PREFIXES.some((prefix) => cleanPath.startsWith(prefix));
};

const isAssistantSessionBusy = (state: AppState): boolean => {
  if (state.pillConversationId !== null) return true;
  if (
    Object.values(state.streamingMessageById).some((entry) =>
      Boolean(entry?.isStreaming),
    )
  ) {
    return true;
  }
  return Object.values(state.agentStateByConversationId).some(
    (run) =>
      run.status === "calling-llm" ||
      run.status === "processing-tools" ||
      run.toolCalls.some((tc) => tc.status === "awaiting-permission"),
  );
};

export type VoiceTypingTipExclusionReason =
  | "uninitialized"
  | "disabled"
  | "snoozed"
  | "unauthenticated"
  | "auth_or_onboarding_route"
  | "recording_hotkey"
  | "sensitive_dialog"
  | "incognito"
  | "active_dictation_or_overlay"
  | "pending_review"
  | "assistant_active"
  | "auto_learn_prompt"
  | "simulated_typing";

const getPreferenceOrRouteExclusion = (
  state: AppState,
  pathname: string,
  nowMs: number,
): VoiceTypingTipExclusionReason | null => {
  if (!state.initialized) return "uninitialized";
  if (!state.local.voiceTypingTip.enabled) return "disabled";
  if (isVoiceTypingTipSnoozed(state.local.voiceTypingTip, nowMs)) {
    return "snoozed";
  }
  if (!state.auth) return "unauthenticated";
  if (isExcludedRoute(pathname)) return "auth_or_onboarding_route";
  return null;
};

const getDialogOrSessionExclusion = (
  state: AppState,
): VoiceTypingTipExclusionReason | null => {
  if (state.isRecordingHotkey) return "recording_hotkey";
  if (
    SENSITIVE_SETTINGS_DIALOG_KEYS.some((key) => Boolean(state.settings[key]))
  ) {
    return "sensitive_dialog";
  }
  if (
    state.userPrefs?.incognitoModeEnabled === true ||
    state.local.ephemeralSessionActive
  ) {
    return "incognito";
  }
  if (state.activeRecordingMode !== null || state.overlayPhase !== "idle") {
    return "active_dictation_or_overlay";
  }
  if (state.pendingPillReview !== null) return "pending_review";
  if (isAssistantSessionBusy(state)) return "assistant_active";
  if (state.autoLearn.proposal !== null) return "auto_learn_prompt";
  return null;
};

export const getVoiceTypingTipExclusionReason = (
  state: AppState,
  pathname: string,
  nowMs: number = Date.now(),
): VoiceTypingTipExclusionReason | null => {
  return (
    getPreferenceOrRouteExclusion(state, pathname, nowMs) ??
    getDialogOrSessionExclusion(state) ??
    (isSimulatedTypingSuppressed(nowMs) ? "simulated_typing" : null)
  );
};

export const shouldClearVisibleVoiceTypingTip = (
  state: AppState,
  pathname: string,
  nowMs: number = Date.now(),
): boolean => {
  return getVoiceTypingTipExclusionReason(state, pathname, nowMs) !== null;
};

export type VoiceTypingTipReadiness =
  | { status: "ready"; shortcutCombo: string[] }
  | { status: "needs_onboarding" }
  | { status: "needs_microphone" }
  | { status: "needs_transcription" }
  | { status: "needs_shortcut" };

const isLocalModelMissing = (state: AppState): boolean => {
  const management = state.settings.aiTranscription.localModelManagement;
  const modelSize = state.settings.aiTranscription.modelSize;
  const isKnownModel = (LOCAL_WHISPER_MODELS as readonly string[]).includes(
    modelSize,
  );
  return (
    management.modelStatusesLoaded &&
    isKnownModel &&
    !isLocalTranscriptionModelSelectable(
      state.settings.aiTranscription,
      modelSize as LocalWhisperModel,
    )
  );
};

export const resolveVoiceTypingTipReadiness = (
  state: AppState,
): VoiceTypingTipReadiness => {
  const user = getMyUser(state);
  if (user && !user.onboarded) {
    return { status: "needs_onboarding" };
  }

  const platform = getPlatform();
  const micMissing =
    (platform === "macos" || platform === "windows") &&
    state.permissions.microphone !== null &&
    !isPermissionAuthorized(state.permissions.microphone.state);
  if (micMissing) {
    return { status: "needs_microphone" };
  }

  const transcriptionPrefs = getTranscriptionPrefs(state);
  if (
    transcriptionPrefs.warnings.length > 0 ||
    (transcriptionPrefs.mode === "local" && isLocalModelMissing(state))
  ) {
    return { status: "needs_transcription" };
  }

  const combos = getHotkeyCombosForAction(state, DICTATE_HOTKEY);
  if (combos.length === 0 || combos[0].length === 0) {
    return { status: "needs_shortcut" };
  }

  return { status: "ready", shortcutCombo: combos[0] };
};

export const formatShortcutComboForDisplay = (
  combo: readonly string[] | null | undefined,
): string | null => {
  if (!combo || combo.length === 0) {
    return null;
  }
  return combo.map((key) => getPrettyKeyName(key)).join(" + ");
};

export const doesElementOverlapBottomRightCorner = (
  rect: Pick<
    DOMRectReadOnly,
    "left" | "right" | "top" | "bottom" | "width" | "height"
  >,
  viewportWidth: number,
  viewportHeight: number,
): boolean => {
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const toastLeft = Math.max(16, viewportWidth - 372);
  const toastRight = viewportWidth - 16;
  const toastTop = Math.max(16, viewportHeight - 168);
  const toastBottom = viewportHeight - 16;

  return (
    rect.right > toastLeft &&
    rect.left < toastRight &&
    rect.bottom > toastTop &&
    rect.top < toastBottom
  );
};
