import { useEffect } from "react";
import { getAppState, produceAppState } from "../../store";
import {
  ASSISTANT_MODE_ENABLED_KEY,
  POWER_MODE_ENABLED_KEY,
} from "../../utils/assistant-mode.utils";
import {
  beginLocalDataWrite,
  withLocalDataWriteSync,
} from "../../utils/local-data-write-gate";
import {
  getLocalStorage,
  getLocalStorageBool,
} from "../../utils/local-storage.utils";
import {
  LEGACY_ASSISTANT_MODE_ENABLED_KEY,
  LEGACY_POWER_MODE_ENABLED_KEY,
  readValidatedLegacyBooleanFlag,
} from "../../utils/voquill-client-migration.utils";

type MigratedPreference = {
  key: string;
  legacyKey: string;
  getCurrent: () => boolean;
  update: (value: boolean) => void;
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
      for (const migration of migrations) {
        try {
          if (storage.getItem(migration.key) !== null) {
            migration.update(getLocalStorageBool(migration.key));
            withLocalDataWriteSync(() => {
              storage.removeItem(migration.key);
            }, releaseWrite.lease);
            continue;
          }

          // Non-destructively hydrate legacy Voquill boolean flags only when
          // the current flag is still at its default false and no mausVoice
          // key superseded it.
          if (!migration.getCurrent()) {
            const legacyValue = readValidatedLegacyBooleanFlag(
              storage,
              migration.legacyKey,
            );
            if (legacyValue === true) {
              migration.update(true);
            }
          }
        } catch (error) {
          console.error(
            `Unable to migrate localStorage key "${migration.key}":`,
            error,
          );
        }
      }
    } finally {
      releaseWrite();
    }
  }, []);

  return null;
};
