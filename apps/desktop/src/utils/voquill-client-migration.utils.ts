import { INITIAL_LOCAL_STATE, type LocalState } from "../state/local.state";
import type { OnboardingPageKey } from "../state/onboarding.state";
import {
  ASSISTANT_MODE_ENABLED_KEY,
  POWER_MODE_ENABLED_KEY,
} from "./assistant-mode.utils";
import {
  LEGACY_LOCAL_STATE_STORAGE_KEY,
  LEGACY_THEME_MODE_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
} from "./local-storage.utils";

export const LEGACY_ASSISTANT_MODE_ENABLED_KEY =
  "voquill:assistant-mode-enabled";
export const LEGACY_POWER_MODE_ENABLED_KEY = "voquill:power-mode-enabled";
export const LEGACY_MODE_FLAGS_MIGRATED_KEY =
  "mausvoice:voquill-mode-flags-migrated";

export type LegacyModeFlagField = "assistantModeEnabled" | "powerModeEnabled";

const LEGACY_MODE_FLAG_SPECS: ReadonlyArray<{
  field: LegacyModeFlagField;
  currentKey: string;
  legacyKey: string;
}> = [
  {
    field: "assistantModeEnabled",
    currentKey: ASSISTANT_MODE_ENABLED_KEY,
    legacyKey: LEGACY_ASSISTANT_MODE_ENABLED_KEY,
  },
  {
    field: "powerModeEnabled",
    currentKey: POWER_MODE_ENABLED_KEY,
    legacyKey: LEGACY_POWER_MODE_ENABLED_KEY,
  },
];

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
const VALID_ONBOARDING_RESUME_PAGES = new Set<OnboardingPageKey>([
  "signIn",
  "personalCredentials",
  "chooseTranscription",
  "chooseLlm",
  "userDetails",
  "referralSource",
  "micPerms",
  "a11yPerms",
  "keybindings",
  "micCheck",
  "unlockedPro",
  "tutorial",
]);

const isOnboardingResumePageOrNull = (
  value: unknown,
): value is OnboardingPageKey | null =>
  value === null ||
  (typeof value === "string" &&
    VALID_ONBOARDING_RESUME_PAGES.has(value as OnboardingPageKey));

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

const isFiniteNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "number" && Number.isFinite(entry));

const isTimingStagesRecord = (
  value: unknown,
): value is Record<string, number[]> =>
  isPlainObject(value) && Object.values(value).every(isFiniteNumberArray);

const isTimingAggregateRecord = (
  value: unknown,
): value is LocalState["providerTiming"] => {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isPlainObject(entry) &&
      isNonNegativeInteger(entry.samples) &&
      isTimingStagesRecord(entry.stages),
  );
};

const cloneTimingAggregateRecord = (
  value: unknown,
): LocalState["providerTiming"] => {
  const record = value as LocalState["providerTiming"];
  const cloned: LocalState["providerTiming"] = {};
  for (const [provider, aggregate] of Object.entries(record)) {
    const stages: Record<string, number[]> = {};
    for (const [stage, values] of Object.entries(aggregate.stages)) {
      stages[stage] = [...values];
    }
    cloned[provider] = { samples: aggregate.samples, stages };
  }
  return cloned;
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
  { key: "onboardingResumePage", validate: isOnboardingResumePageOrNull },
  { key: "onboardingNameDraft", validate: (v) => typeof v === "string" },
  { key: "onboardingNameDraftUserId", validate: isStringOrNull },
  { key: "onboardingSessionUserId", validate: isStringOrNull },
  {
    key: "providerTiming",
    validate: isTimingAggregateRecord,
    clone: cloneTimingAggregateRecord,
  },
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

const collectAbsentLegacyModeUpdates = (
  storage: StorageAccess,
  existingLocal: Record<string, unknown> | null,
): Partial<Record<LegacyModeFlagField, true>> => {
  const updates: Partial<Record<LegacyModeFlagField, true>> = {};
  for (const spec of LEGACY_MODE_FLAG_SPECS) {
    const hasCurrentFlag = storage.getItem(spec.currentKey) !== null;
    const hasPersistedBool =
      existingLocal !== null && typeof existingLocal[spec.field] === "boolean";
    if (hasCurrentFlag || hasPersistedBool) {
      continue;
    }
    const raw = storage.getItem(spec.legacyKey);
    const parsed = raw === null ? null : parseJsonBoolean(raw);
    if (parsed === true) {
      updates[spec.field] = true;
    }
  }
  return updates;
};

/**
 * Computes which legacy Voquill standalone mode flags (`voquill:*-mode-enabled`)
 * should be hydrated into `local` state before any store mutation persists
 * sibling default values.
 *
 * Throws if storage reads fail so callers do not mark one-time migration
 * complete prematurely.
 */
export const collectPendingLegacyModeFlagUpdates = (
  storage: Pick<Storage, "getItem">,
  currentStateKey: string = LOCAL_STATE_STORAGE_KEY,
): Partial<Record<LegacyModeFlagField, true>> => {
  const rawState = storage.getItem(currentStateKey);
  const parsedState = rawState !== null ? parseJsonObject(rawState) : null;
  const existingLocal = parsedState ? extractCandidateLocal(parsedState) : null;
  return collectAbsentLegacyModeUpdates(
    storage as StorageAccess,
    existingLocal,
  );
};

const mergePersistedLocalState = (
  parsedState: Record<string, unknown> | null,
  existingLocal: Record<string, unknown> | null,
  updates: Partial<Record<LegacyModeFlagField, true>>,
): Record<string, unknown> => {
  const baseState =
    parsedState && isPlainObject(parsedState.state)
      ? { ...parsedState.state }
      : {};
  const version =
    parsedState &&
    typeof parsedState.version === "number" &&
    Number.isInteger(parsedState.version)
      ? parsedState.version
      : 0;
  return {
    ...parsedState,
    state: {
      ...baseState,
      local: { ...existingLocal, ...updates },
    },
    version,
  };
};

const hydrateAbsentLegacyModeFlags = (
  storage: StorageAccess,
  write: (fn: () => void) => void,
  currentStateKey: string,
): void => {
  if (
    currentStateKey !== LOCAL_STATE_STORAGE_KEY ||
    storage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY) !== null
  ) {
    return;
  }

  const rawState = storage.getItem(currentStateKey);
  const parsedState = rawState !== null ? parseJsonObject(rawState) : null;
  const existingLocal = parsedState ? extractCandidateLocal(parsedState) : null;
  const updates = collectAbsentLegacyModeUpdates(storage, existingLocal);

  if (Object.keys(updates).length > 0) {
    const nextEnvelope = mergePersistedLocalState(
      parsedState,
      existingLocal,
      updates,
    );
    write(() => {
      storage.setItem(currentStateKey, JSON.stringify(nextEnvelope));
    });
  }

  write(() => {
    storage.setItem(LEGACY_MODE_FLAGS_MIGRATED_KEY, "1");
  });
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

  // Hydrate absent legacy standalone mode flags (`voquill:*-mode-enabled`) at
  // most once before Zustand hydrates, without ever overriding an explicit
  // `false` already stored in `mausvoice-local-state`.
  try {
    hydrateAbsentLegacyModeFlags(storage, write, currentStateKey);
  } catch {
    // Non-fatal: MigratorSideEffects still guards itself on mount.
  }

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
