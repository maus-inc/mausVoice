import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import {
  dismissVoquillMigrationNotice,
  fetchVoquillMigrationStatus,
  retryVoquillMigration,
} from "../repos/voquill-migration.repo";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { withLocalDataWrite } from "../utils/local-data-write-gate";
import { loadApiKeys } from "./api-key.actions";
import { loadAppTargets } from "./app-target.actions";
import { loadDictionary } from "./dictionary.actions";
import { loadHotkeys } from "./hotkey.actions";
import { loadTones } from "./tone.actions";
import { refreshCurrentUser } from "./user.actions";

let loadPromise: Promise<VoquillMigrationReport | null> | null = null;

export const loadVoquillMigrationStatus = async (
  force = false,
): Promise<VoquillMigrationReport | null> => {
  const current = getAppState().voquillMigration;
  if (!force && current.status === "loading" && loadPromise) {
    return loadPromise;
  }
  if (!force && current.status === "success" && current.report !== null) {
    return current.report;
  }

  produceAppState((draft) => {
    draft.voquillMigration.status = "loading";
    draft.voquillMigration.error = null;
  });

  loadPromise = fetchVoquillMigrationStatus()
    .then((report) => {
      produceAppState((draft) => {
        draft.voquillMigration.report = report;
        draft.voquillMigration.status = "success";
        draft.voquillMigration.error = null;
      });
      return report;
    })
    .catch((error) => {
      getLogger().warning(`Failed to load Voquill migration status: ${error}`);
      produceAppState((draft) => {
        draft.voquillMigration.status = "error";
        draft.voquillMigration.error =
          error instanceof Error ? error.message : String(error);
      });
      return null;
    })
    .finally(() => {
      loadPromise = null;
    });

  return loadPromise;
};

export const dismissVoquillMigration =
  async (): Promise<VoquillMigrationReport | null> => {
    if (getAppState().voquillMigration.dismissing) {
      return getAppState().voquillMigration.report;
    }

    produceAppState((draft) => {
      draft.voquillMigration.dismissing = true;
      draft.voquillMigration.error = null;
    });

    try {
      const report = await dismissVoquillMigrationNotice();
      produceAppState((draft) => {
        draft.voquillMigration.report = report;
        draft.voquillMigration.status = "success";
        draft.voquillMigration.dismissing = false;
      });
      return report;
    } catch (error) {
      getLogger().warning(
        `Failed to dismiss Voquill migration notice: ${error}`,
      );
      produceAppState((draft) => {
        draft.voquillMigration.dismissing = false;
        draft.voquillMigration.error =
          error instanceof Error ? error.message : String(error);
      });
      return null;
    }
  };

export const runVoquillMigrationRetry =
  async (): Promise<VoquillMigrationReport> => {
    if (getAppState().voquillMigration.retrying) {
      const existing = getAppState().voquillMigration.report;
      if (existing) {
        return existing;
      }
    }

    const previousDatabasePhase =
      getAppState().voquillMigration.report?.databasePhase;

    produceAppState((draft) => {
      draft.voquillMigration.retrying = true;
      draft.voquillMigration.error = null;
    });

    try {
      const report = await withLocalDataWrite((lease) =>
        retryVoquillMigration(lease),
      );

      produceAppState((draft) => {
        draft.voquillMigration.report = report;
        draft.voquillMigration.status = "success";
        draft.voquillMigration.retrying = false;
        draft.voquillMigration.error = null;
        if (
          previousDatabasePhase !== "migrated" &&
          report.databasePhase === "migrated"
        ) {
          // Force API keys reload so the newly swapped migrated DB is hydrated.
          draft.settings.apiKeysStatus = "idle";
        }
      });

      if (
        previousDatabasePhase !== "migrated" &&
        report.databasePhase === "migrated"
      ) {
        await Promise.allSettled([
          refreshCurrentUser(),
          loadApiKeys(),
          loadHotkeys(),
          loadDictionary(),
          loadTones(),
          loadAppTargets(),
        ]);
      }

      return report;
    } catch (error) {
      getLogger().error(`Failed to retry Voquill migration: ${error}`);
      produceAppState((draft) => {
        draft.voquillMigration.retrying = false;
        draft.voquillMigration.error =
          error instanceof Error ? error.message : String(error);
      });
      throw error;
    }
  };
