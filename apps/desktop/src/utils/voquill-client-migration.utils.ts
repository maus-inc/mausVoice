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

const LEGACY_CHECKLIST_STORAGE_MAPPINGS: ReadonlyArray<{
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

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

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

type LocalFieldSpec = {
  key: keyof LocalState;
  validate: (value: unknown) => boolean;
  clone?: (value: unknown) => unknown;
};

const LOCAL_STATE_FIELD_SPECS: readonly LocalFieldSpec[] = [
  { key: "assistantModeEnabled", validate: (v) => typeof v === "boolean" },
  { key: "powerModeEnabled", validate: (v) => typeof v === "boolean" },
  { key: "disablePillRewards", validate: (v) => typeof v === "boolean" },
  {
    key: "hasHiddenTrialExtensionCard",
    validate: (v) => typeof v === "boolean",
  },
  { key: "disableAutoStyleLoading", validate: (v) => typeof v === "boolean" },
  {
    key: "lastDictationReminderShownAt",
    validate: isFiniteNumberOrNull,
  },
  { key: "lastDictatedAt", validate: isFiniteNumberOrNull },
  {
    key: "lastSeenTrialExtensionClaimedAt",
    validate: isStringOrNull,
  },
  { key: "featureSeenAt", validate: isStringOrNull },
  { key: "onboardingFlowVersion", validate: isNonNegativeInteger },
  {
    key: "dismissedTipIds",
    validate: isStringArray,
    clone: (v) => [...(v as string[])],
  },
  {
    key: "completedPrerequisites",
    validate: isStringArray,
    clone: (v) => [...(v as string[])],
  },
  { key: "onboardingNameDraft", validate: (v) => typeof v === "string" },
  { key: "onboardingNameDraftUserId", validate: isStringOrNull },
  { key: "onboardingSessionUserId", validate: isStringOrNull },
  { key: "providerTiming", validate: isTimingAggregateRecord },
  {
    key: "profileImageByUserId",
    validate: isStringRecord,
    clone: (v) => ({ ...(v as Record<string, string>) }),
  },
];

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const extractCandidateLocal = (
  parsed: Record<string, unknown>,
): Record<string, unknown> | null => {
  if (isPlainObject(parsed.state) && isPlainObject(parsed.state.local)) {
    return parsed.state.local;
  }
  return isPlainObject(parsed.local) ? parsed.local : null;
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
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }

  const candidateLocal = extractCandidateLocal(parsed);
  if (!candidateLocal) {
    return null;
  }

  const sanitized: Record<string, unknown> = {
    ephemeralSessionActive: INITIAL_LOCAL_STATE.ephemeralSessionActive,
  };
  let acceptedFieldCount = 0;

  for (const spec of LOCAL_STATE_FIELD_SPECS) {
    const value = candidateLocal[spec.key];
    if (spec.validate(value)) {
      sanitized[spec.key] = spec.clone ? spec.clone(value) : value;
      acceptedFieldCount += 1;
    }
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

type StorageAccess = Pick<Storage, "getItem" | "setItem">;

const migrateSingleStorageKey = ({
  storage,
  write,
  legacyKey,
  currentKey,
  transform,
  result,
}: {
  storage: StorageAccess;
  write: (fn: () => void) => void;
  legacyKey: string;
  currentKey: string;
  transform: (raw: string) => string | null;
  result: ClientStorageMigrationResult;
}): void => {
  try {
    if (storage.getItem(currentKey) !== null) {
      result.skippedKeys.push(currentKey);
      return;
    }
    const legacyRaw = storage.getItem(legacyKey);
    if (legacyRaw === null) {
      return;
    }
    const migratedValue = transform(legacyRaw);
    if (migratedValue === null) {
      result.invalidKeys.push(legacyKey);
      return;
    }
    write(() => {
      storage.setItem(currentKey, migratedValue);
    });
    result.migratedKeys.push(currentKey);
  } catch {
    result.invalidKeys.push(legacyKey);
  }
};

const transformBooleanFlag = (raw: string): string | null => {
  const parsed = parseJsonBoolean(raw);
  return parsed === null ? null : JSON.stringify(parsed);
};

const transformThemeMode = (raw: string): string | null =>
  VALID_THEME_MODES.has(raw) ? raw : null;

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
  storage: StorageAccess,
  write: (fn: () => void) => void = (fn) => fn(),
  currentStateKey: string = LOCAL_STATE_STORAGE_KEY,
): ClientStorageMigrationResult => {
  const result: ClientStorageMigrationResult = {
    migratedKeys: [],
    skippedKeys: [],
    invalidKeys: [],
  };

  migrateSingleStorageKey({
    storage,
    write,
    legacyKey: LEGACY_LOCAL_STATE_STORAGE_KEY,
    currentKey: currentStateKey,
    transform: sanitizeLegacyPersistedLocalState,
    result,
  });

  for (const { legacyKey, currentKey } of LEGACY_CHECKLIST_STORAGE_MAPPINGS) {
    migrateSingleStorageKey({
      storage,
      write,
      legacyKey,
      currentKey,
      transform: transformBooleanFlag,
      result,
    });
  }

  migrateSingleStorageKey({
    storage,
    write,
    legacyKey: LEGACY_THEME_MODE_STORAGE_KEY,
    currentKey: THEME_MODE_STORAGE_KEY,
    transform: transformThemeMode,
    result,
  });

  return result;
};

/**
 * Reads a legacy standalone boolean flag (`"true"` / `"false"`) from storage
 * without mutating the source key. Returns `null` when absent or malformed.
 */
export const readValidatedLegacyBooleanFlag = (
  storage: Pick<Storage, "getItem">,
  legacyKey: string,
): boolean | null => {
  try {
    const raw = storage.getItem(legacyKey);
    return raw === null ? null : parseJsonBoolean(raw);
  } catch {
    return null;
  }
};
