import { INITIAL_LOCAL_STATE, type LocalState } from "../state/local.state";
import {
  LEGACY_LOCAL_STATE_STORAGE_KEY,
  LEGACY_THEME_MODE_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
} from "./local-storage.utils";

export const LEGACY_ASSISTANT_MODE_ENABLED_KEY =
  "voquill:assistant-mode-enabled";
export const LEGACY_POWER_MODE_ENABLED_KEY = "voquill:power-mode-enabled";

export const LEGACY_CHECKLIST_STORAGE_MAPPINGS: ReadonlyArray<{
  legacyKey: string;
  currentKey: string;
}> = [
  {
    legacyKey: "voquill:checklist-dismissed",
    currentKey: "mausvoice:checklist-dismissed",
  },
  {
    legacyKey: "voquill:checklist-dictionary",
    currentKey: "mausvoice:checklist-dictionary",
  },
  {
    legacyKey: "voquill:checklist-writing-style",
    currentKey: "mausvoice:checklist-writing-style",
  },
];

const VALID_THEME_MODES = new Set(["light", "dark", "system"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isPlainObject(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const isTimingAggregateRecord = (
  value: unknown,
): value is LocalState["providerTiming"] => {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isPlainObject(entry) &&
      typeof entry.count === "number" &&
      Number.isFinite(entry.count) &&
      typeof entry.medianMs === "number" &&
      Number.isFinite(entry.medianMs),
  );
};

/**
 * Validates and sanitizes a raw legacy `voquill-local-state` JSON payload into
 * a safe Zustand persisted envelope for `mausvoice-local-state`.
 *
 * Unknown or removed Voquill fields and mismatched types are silently ignored,
 * `ephemeralSessionActive` is always forced false, and malformed JSON returns
 * `null` so the caller safely falls back to defaults instead of corrupting
 * mausVoice storage.
 */
export const sanitizeLegacyPersistedLocalState = (
  raw: string,
): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) {
    return null;
  }

  let candidateLocal: unknown = null;
  if (isPlainObject(parsed.state) && isPlainObject(parsed.state.local)) {
    candidateLocal = parsed.state.local;
  } else if (isPlainObject(parsed.local)) {
    candidateLocal = parsed.local;
  }

  if (!isPlainObject(candidateLocal)) {
    return null;
  }

  const sanitized: Partial<LocalState> = {
    ephemeralSessionActive: INITIAL_LOCAL_STATE.ephemeralSessionActive,
  };
  let acceptedFieldCount = 0;

  const copyBoolean = (
    key:
      | "assistantModeEnabled"
      | "powerModeEnabled"
      | "disablePillRewards"
      | "hasHiddenTrialExtensionCard"
      | "disableAutoStyleLoading",
  ) => {
    const value = candidateLocal[key];
    if (typeof value === "boolean") {
      sanitized[key] = value;
      acceptedFieldCount += 1;
    }
  };

  copyBoolean("assistantModeEnabled");
  copyBoolean("powerModeEnabled");
  copyBoolean("disablePillRewards");
  copyBoolean("hasHiddenTrialExtensionCard");
  copyBoolean("disableAutoStyleLoading");

  if (isFiniteNumberOrNull(candidateLocal.lastDictationReminderShownAt)) {
    sanitized.lastDictationReminderShownAt =
      candidateLocal.lastDictationReminderShownAt;
    acceptedFieldCount += 1;
  }
  if (isFiniteNumberOrNull(candidateLocal.lastDictatedAt)) {
    sanitized.lastDictatedAt = candidateLocal.lastDictatedAt;
    acceptedFieldCount += 1;
  }
  if (isStringOrNull(candidateLocal.lastSeenTrialExtensionClaimedAt)) {
    sanitized.lastSeenTrialExtensionClaimedAt =
      candidateLocal.lastSeenTrialExtensionClaimedAt;
    acceptedFieldCount += 1;
  }
  if (isStringOrNull(candidateLocal.featureSeenAt)) {
    sanitized.featureSeenAt = candidateLocal.featureSeenAt;
    acceptedFieldCount += 1;
  }
  if (
    typeof candidateLocal.onboardingFlowVersion === "number" &&
    Number.isInteger(candidateLocal.onboardingFlowVersion) &&
    candidateLocal.onboardingFlowVersion >= 0
  ) {
    sanitized.onboardingFlowVersion = candidateLocal.onboardingFlowVersion;
    acceptedFieldCount += 1;
  }
  if (isStringArray(candidateLocal.dismissedTipIds)) {
    sanitized.dismissedTipIds = [...candidateLocal.dismissedTipIds];
    acceptedFieldCount += 1;
  }
  if (isStringArray(candidateLocal.completedPrerequisites)) {
    sanitized.completedPrerequisites = [
      ...candidateLocal.completedPrerequisites,
    ];
    acceptedFieldCount += 1;
  }
  if (typeof candidateLocal.onboardingNameDraft === "string") {
    sanitized.onboardingNameDraft = candidateLocal.onboardingNameDraft;
    acceptedFieldCount += 1;
  }
  if (isStringOrNull(candidateLocal.onboardingNameDraftUserId)) {
    sanitized.onboardingNameDraftUserId =
      candidateLocal.onboardingNameDraftUserId;
    acceptedFieldCount += 1;
  }
  if (isStringOrNull(candidateLocal.onboardingSessionUserId)) {
    sanitized.onboardingSessionUserId = candidateLocal.onboardingSessionUserId;
    acceptedFieldCount += 1;
  }
  if (isTimingAggregateRecord(candidateLocal.providerTiming)) {
    sanitized.providerTiming = candidateLocal.providerTiming;
    acceptedFieldCount += 1;
  }
  if (isStringRecord(candidateLocal.profileImageByUserId)) {
    sanitized.profileImageByUserId = { ...candidateLocal.profileImageByUserId };
    acceptedFieldCount += 1;
  }

  // If the parsed object held zero recognizable LocalState keys (e.g. an empty
  // or unrelated JSON document), still allow an empty-but-valid Zustand object
  // only when `state.local` was explicitly structured as a Zustand envelope.
  if (acceptedFieldCount === 0 && !isPlainObject(parsed.state)) {
    return null;
  }

  const version =
    typeof parsed.version === "number" && Number.isInteger(parsed.version)
      ? parsed.version
      : 0;

  return JSON.stringify({
    state: { local: sanitized },
    version,
  });
};

export type ClientStorageMigrationResult = {
  migratedKeys: string[];
  skippedKeys: string[];
  invalidKeys: string[];
};

const parseJsonBoolean = (raw: string): boolean | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Non-destructively and idempotently migrates legacy Voquill client-side
 * `localStorage` keys into their mausVoice equivalents.
 *
 * Guarantees:
 * - Never overwrites an existing mausVoice key.
 * - Never deletes or modifies legacy Voquill keys (safe rollback).
 * - Validates every value before copying so corrupt or obsolete legacy data
 *   cannot poison mausVoice state.
 */
export const migrateLegacyVoquillClientStorage = (
  storage: Pick<Storage, "getItem" | "setItem">,
  write: (fn: () => void) => void = (fn) => fn(),
  currentStateKey: string = LOCAL_STATE_STORAGE_KEY,
): ClientStorageMigrationResult => {
  const result: ClientStorageMigrationResult = {
    migratedKeys: [],
    skippedKeys: [],
    invalidKeys: [],
  };

  // 1. Zustand persisted local slice: voquill-local-state -> mausvoice-local-state
  try {
    const current = storage.getItem(currentStateKey);
    if (current !== null) {
      result.skippedKeys.push(currentStateKey);
    } else {
      const legacy = storage.getItem(LEGACY_LOCAL_STATE_STORAGE_KEY);
      if (legacy !== null) {
        const sanitized = sanitizeLegacyPersistedLocalState(legacy);
        if (sanitized !== null) {
          write(() => {
            storage.setItem(currentStateKey, sanitized);
          });
          result.migratedKeys.push(currentStateKey);
        } else {
          result.invalidKeys.push(LEGACY_LOCAL_STATE_STORAGE_KEY);
        }
      }
    }
  } catch {
    result.invalidKeys.push(LEGACY_LOCAL_STATE_STORAGE_KEY);
  }

  // 2. Onboarding / getting-started checklist booleans
  for (const { legacyKey, currentKey } of LEGACY_CHECKLIST_STORAGE_MAPPINGS) {
    try {
      if (storage.getItem(currentKey) !== null) {
        result.skippedKeys.push(currentKey);
        continue;
      }
      const legacyRaw = storage.getItem(legacyKey);
      if (legacyRaw === null) continue;
      const parsedBool = parseJsonBoolean(legacyRaw);
      if (parsedBool === null) {
        result.invalidKeys.push(legacyKey);
        continue;
      }
      write(() => {
        storage.setItem(currentKey, JSON.stringify(parsedBool));
      });
      result.migratedKeys.push(currentKey);
    } catch {
      result.invalidKeys.push(legacyKey);
    }
  }

  // 3. Theme mode: legacy `mode` -> `mui-mode`
  try {
    if (storage.getItem(THEME_MODE_STORAGE_KEY) !== null) {
      result.skippedKeys.push(THEME_MODE_STORAGE_KEY);
    } else {
      const legacyMode = storage.getItem(LEGACY_THEME_MODE_STORAGE_KEY);
      if (legacyMode !== null) {
        if (VALID_THEME_MODES.has(legacyMode)) {
          write(() => {
            storage.setItem(THEME_MODE_STORAGE_KEY, legacyMode);
          });
          result.migratedKeys.push(THEME_MODE_STORAGE_KEY);
        } else {
          result.invalidKeys.push(LEGACY_THEME_MODE_STORAGE_KEY);
        }
      }
    }
  } catch {
    result.invalidKeys.push(LEGACY_THEME_MODE_STORAGE_KEY);
  }

  return result;
};

/**
 * Reads a legacy Voquill boolean flag (`voquill:assistant-mode-enabled`,
 * `voquill:power-mode-enabled`) strictly, returning `null` if absent or invalid.
 */
export const readValidatedLegacyBooleanFlag = (
  storage: Pick<Storage, "getItem">,
  key: string,
): boolean | null => {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return parseJsonBoolean(raw);
  } catch {
    return null;
  }
};
