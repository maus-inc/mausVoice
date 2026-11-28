export const VOICE_TYPING_TIP_MIN_BURST_MS = 5_000;
export const VOICE_TYPING_TIP_MIN_KEYSTROKES = 8;
export const VOICE_TYPING_TIP_MAX_GAP_MS = 1_800;
export const VOICE_TYPING_TIP_NO_THANKS_DELAY_MS = 10_000;
export const VOICE_TYPING_TIP_SNOOZE_MS = 60 * 60 * 1_000;
export const VOICE_TYPING_TIP_DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const VOICE_TYPING_TIP_AUTO_DISABLE_THRESHOLD = 5;
export const VOICE_TYPING_TIP_POST_CLOSE_COOLDOWN_MS = 60_000;
export const VOICE_TYPING_TIP_COPY_VARIANT_COUNT = 4;

export type VoiceTypingTipDisabledReason =
  "manual" | "auto_dismiss_limit" | null;

export type VoiceTypingTipLocalState = {
  enabled: boolean;
  disabledReason: VoiceTypingTipDisabledReason;
  snoozedUntilMs: number | null;
  noThanksTimestampsMs: number[];
  autoDisabledAtMs: number | null;
  nextVariantIndex: number;
};

export const INITIAL_VOICE_TYPING_TIP_LOCAL_STATE: VoiceTypingTipLocalState = {
  enabled: true,
  disabledReason: null,
  snoozedUntilMs: null,
  noThanksTimestampsMs: [],
  autoDisabledAtMs: null,
  nextVariantIndex: 0,
};

export type VoiceTypingTipCtaKind = "try" | "setup";

export type VoiceTypingTipPromptState = {
  id: number;
  variantIndex: number;
  ctaKind: VoiceTypingTipCtaKind;
  shortcutCombo: string[] | null;
  shownAtMs: number;
  noThanksRevealAtMs: number;
  noThanksVisible: boolean;
  mirroredOnPill: boolean;
};

const isFinitePositiveTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const resolveDisabledReason = (
  enabled: boolean,
  rawReason: unknown,
): VoiceTypingTipDisabledReason => {
  if (enabled) return null;
  return rawReason === "auto_dismiss_limit" ? "auto_dismiss_limit" : "manual";
};

const sanitizeDismissTimestamps = (
  rawList: unknown,
  nowMs: number,
): number[] => {
  if (!Array.isArray(rawList)) return [];
  const windowStartMs = nowMs - VOICE_TYPING_TIP_DISMISS_WINDOW_MS;
  return rawList
    .filter(isFinitePositiveTimestamp)
    .map((ts) => Math.min(ts, nowMs))
    .filter((ts) => ts > windowStartMs)
    .sort((a, b) => a - b)
    .slice(-VOICE_TYPING_TIP_AUTO_DISABLE_THRESHOLD);
};

const sanitizeSnoozedUntil = (
  enabled: boolean,
  rawSnoozedUntil: unknown,
  nowMs: number,
): number | null => {
  if (!enabled || !isFinitePositiveTimestamp(rawSnoozedUntil)) {
    return null;
  }
  const clamped = Math.min(rawSnoozedUntil, nowMs + VOICE_TYPING_TIP_SNOOZE_MS);
  return clamped > nowMs ? clamped : null;
};

const sanitizeAutoDisabledAt = (
  enabled: boolean,
  disabledReason: VoiceTypingTipDisabledReason,
  rawAutoDisabledAt: unknown,
  nowMs: number,
): number | null => {
  if (
    enabled ||
    disabledReason !== "auto_dismiss_limit" ||
    !isFinitePositiveTimestamp(rawAutoDisabledAt)
  ) {
    return null;
  }
  return Math.min(rawAutoDisabledAt, nowMs);
};

const sanitizeVariantIndex = (rawIndex: unknown): number => {
  const numeric =
    typeof rawIndex === "number" && Number.isFinite(rawIndex)
      ? Math.trunc(rawIndex)
      : 0;
  return (
    ((numeric % VOICE_TYPING_TIP_COPY_VARIANT_COUNT) +
      VOICE_TYPING_TIP_COPY_VARIANT_COUNT) %
    VOICE_TYPING_TIP_COPY_VARIANT_COUNT
  );
};

/**
 * Sanitizes persisted voice-typing tip state against corrupted storage and
 * forward-then-backward system clock jumps so snooze and rolling 7-day
 * dismissal windows never get stuck in the future.
 */
export const normalizeVoiceTypingTipLocalState = (
  raw: unknown,
  nowMs: number = Date.now(),
): VoiceTypingTipLocalState => {
  if (!raw || typeof raw !== "object") {
    return { ...INITIAL_VOICE_TYPING_TIP_LOCAL_STATE };
  }

  const record = raw as Partial<VoiceTypingTipLocalState>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const disabledReason = resolveDisabledReason(enabled, record.disabledReason);

  return {
    enabled,
    disabledReason,
    snoozedUntilMs: sanitizeSnoozedUntil(enabled, record.snoozedUntilMs, nowMs),
    noThanksTimestampsMs: sanitizeDismissTimestamps(
      record.noThanksTimestampsMs,
      nowMs,
    ),
    autoDisabledAtMs: sanitizeAutoDisabledAt(
      enabled,
      disabledReason,
      record.autoDisabledAtMs,
      nowMs,
    ),
    nextVariantIndex: sanitizeVariantIndex(record.nextVariantIndex),
  };
};
