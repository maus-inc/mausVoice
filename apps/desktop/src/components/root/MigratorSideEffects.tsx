import { useEffect } from "react";
import { produceAppState } from "../../store";
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

type MigratedPreference = {
  key: string;
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
        update: (value) => {
          produceAppState((draft) => {
            draft.local.assistantModeEnabled = value;
          }, releaseWrite.lease);
        },
      },
      {
        key: POWER_MODE_ENABLED_KEY,
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
          if (storage.getItem(migration.key) === null) continue;
          migration.update(getLocalStorageBool(migration.key));
          withLocalDataWriteSync(() => {
            storage.removeItem(migration.key);
          }, releaseWrite.lease);
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
