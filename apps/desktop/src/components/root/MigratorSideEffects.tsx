import { useEffect } from "react";
import { getAppState, produceAppState } from "../../store";
import {
  ASSISTANT_MODE_ENABLED_KEY,
  POWER_MODE_ENABLED_KEY,
} from "../../utils/assistant-mode.utils";
import {
  beginLocalDataWrite,
  type LocalDataWriteLease,
  withLocalDataWriteSync,
} from "../../utils/local-data-write-gate";
import {
  getLocalStorage,
  getLocalStorageBool,
} from "../../utils/local-storage.utils";
import {
  LEGACY_MODE_FLAGS_MIGRATED_KEY,
  collectPendingLegacyModeFlagUpdates,
  type LegacyModeFlagField,
} from "../../utils/voquill-client-migration.utils";

type MigratedPreference = {
  field: LegacyModeFlagField;
  key: string;
  getCurrent: () => boolean;
  update: (value: boolean) => void;
};

const migrateSinglePreference = (
  storage: Storage,
  lease: LocalDataWriteLease,
  migration: MigratedPreference,
  legacyShouldEnable: boolean,
): void => {
  if (storage.getItem(migration.key) !== null) {
    migration.update(getLocalStorageBool(migration.key));
    withLocalDataWriteSync(() => {
      storage.removeItem(migration.key);
    }, lease);
    return;
  }

  if (legacyShouldEnable && !migration.getCurrent()) {
    migration.update(true);
  }
};

const buildModeMigrations = (
  lease: LocalDataWriteLease,
): MigratedPreference[] => [
  {
    field: "assistantModeEnabled",
    key: ASSISTANT_MODE_ENABLED_KEY,
    getCurrent: () => getAppState().local.assistantModeEnabled,
    update: (value) => {
      produceAppState((draft) => {
        draft.local.assistantModeEnabled = value;
      }, lease);
    },
  },
  {
    field: "powerModeEnabled",
    key: POWER_MODE_ENABLED_KEY,
    getCurrent: () => getAppState().local.powerModeEnabled,
    update: (value) => {
      produceAppState((draft) => {
        draft.local.powerModeEnabled = value;
      }, lease);
    },
  },
];

const readLegacyMigrationSnapshot = (
  storage: Storage,
): {
  allowLegacyHydration: boolean;
  pendingLegacyUpdates: Partial<Record<LegacyModeFlagField, true>>;
  readOk: boolean;
} => {
  try {
    const allowLegacyHydration =
      storage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY) === null;
    const pendingLegacyUpdates = allowLegacyHydration
      ? collectPendingLegacyModeFlagUpdates(storage)
      : {};
    return { allowLegacyHydration, pendingLegacyUpdates, readOk: true };
  } catch (error) {
    console.error(
      "Unable to inspect legacy Voquill mode flags in localStorage:",
      error,
    );
    return {
      allowLegacyHydration: false,
      pendingLegacyUpdates: {},
      readOk: false,
    };
  }
};

const runModeFlagMigrations = (
  storage: Storage,
  lease: LocalDataWriteLease,
): void => {
  // Snapshot legacy eligibility for all flags before calling any `update`,
  // so persisting one flag through Zustand cannot mark sibling flags as
  // already persisted before their turn in the loop.
  const { allowLegacyHydration, pendingLegacyUpdates, readOk } =
    readLegacyMigrationSnapshot(storage);
  let allSucceeded = readOk;

  for (const migration of buildModeMigrations(lease)) {
    try {
      migrateSinglePreference(
        storage,
        lease,
        migration,
        allowLegacyHydration && pendingLegacyUpdates[migration.field] === true,
      );
    } catch (error) {
      allSucceeded = false;
      console.error(
        `Unable to migrate localStorage key "${migration.key}":`,
        error,
      );
    }
  }

  if (!allowLegacyHydration || !allSucceeded) {
    return;
  }

  try {
    withLocalDataWriteSync(() => {
      storage.setItem(LEGACY_MODE_FLAGS_MIGRATED_KEY, "1");
    }, lease);
  } catch (error) {
    console.error(
      `Unable to persist legacy mode migration marker "${LEGACY_MODE_FLAGS_MIGRATED_KEY}":`,
      error,
    );
  }
};

export const MigratorSideEffects = () => {
  useEffect(() => {
    const releaseWrite = beginLocalDataWrite();
    if (!releaseWrite) return;

    const storage = getLocalStorage();
    if (!storage) {
      releaseWrite();
      return;
    }

    try {
      runModeFlagMigrations(storage, releaseWrite.lease);
    } finally {
      releaseWrite();
    }
  }, []);

  return null;
};
