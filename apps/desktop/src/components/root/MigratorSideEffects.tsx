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
  LEGACY_ASSISTANT_MODE_ENABLED_KEY,
  LEGACY_MODE_FLAGS_MIGRATED_KEY,
  LEGACY_POWER_MODE_ENABLED_KEY,
  hasPersistedLocalBooleanField,
  readValidatedLegacyBooleanFlag,
  type LegacyModeFlagField,
} from "../../utils/voquill-client-migration.utils";

type MigratedPreference = {
  field: LegacyModeFlagField;
  key: string;
  legacyKey: string;
  getCurrent: () => boolean;
  update: (value: boolean) => void;
};

const migrateSinglePreference = (
  storage: Storage,
  lease: LocalDataWriteLease,
  migration: MigratedPreference,
  allowLegacyHydration: boolean,
): void => {
  if (storage.getItem(migration.key) !== null) {
    migration.update(getLocalStorageBool(migration.key));
    withLocalDataWriteSync(() => {
      storage.removeItem(migration.key);
    }, lease);
    return;
  }

  // Non-destructively hydrate absent legacy Voquill boolean flags at most once
  // so an explicit `false` preference (persisted before or after migration) is
  // never overwritten on launch.
  if (
    !allowLegacyHydration ||
    migration.getCurrent() ||
    hasPersistedLocalBooleanField(storage, migration.field)
  ) {
    return;
  }

  const legacyValue = readValidatedLegacyBooleanFlag(
    storage,
    migration.legacyKey,
  );
  if (legacyValue === true) {
    migration.update(true);
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

    const migrations: MigratedPreference[] = [
      {
        field: "assistantModeEnabled",
        key: ASSISTANT_MODE_ENABLED_KEY,
        legacyKey: LEGACY_ASSISTANT_MODE_ENABLED_KEY,
        getCurrent: () => getAppState().local.assistantModeEnabled,
        update: (value) => {
          produceAppState((draft) => {
            draft.local.assistantModeEnabled = value;
          }, releaseWrite.lease);
        },
      },
      {
        field: "powerModeEnabled",
        key: POWER_MODE_ENABLED_KEY,
        legacyKey: LEGACY_POWER_MODE_ENABLED_KEY,
        getCurrent: () => getAppState().local.powerModeEnabled,
        update: (value) => {
          produceAppState((draft) => {
            draft.local.powerModeEnabled = value;
          }, releaseWrite.lease);
        },
      },
    ];

    try {
      const allowLegacyHydration =
        storage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY) === null;

      for (const migration of migrations) {
        try {
          migrateSinglePreference(
            storage,
            releaseWrite.lease,
            migration,
            allowLegacyHydration,
          );
        } catch (error) {
          console.error(
            `Unable to migrate localStorage key "${migration.key}":`,
            error,
          );
        }
      }

      if (allowLegacyHydration) {
        withLocalDataWriteSync(() => {
          storage.setItem(LEGACY_MODE_FLAGS_MIGRATED_KEY, "1");
        }, releaseWrite.lease);
      }
    } finally {
      releaseWrite();
    }
  }, []);

  return null;
};
