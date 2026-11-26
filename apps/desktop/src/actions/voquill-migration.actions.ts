import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import {
  dismissVoquillMigrationNotice,
  fetchVoquillMigrationStatus,
  retryVoquillMigration,
} from "../repos/voquill-migration.repo";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { loadApiKeys } from "./api-key.actions";
import { loadAppTargets } from "./app-target.actions";
import { loadDictionary } from "./dictionary.actions";
import { loadHotkeys } from "./hotkey.actions";
import { loadTones } from "./tone.actions";
import { refreshCurrentUser } from "./user.actions";
import {
  isLatestVoquillMigrationRequestSeq,
  nextVoquillMigrationRequestSeq,
} from "./voquill-migration-refresh";

let loadPromise: Promise<VoquillMigrationReport | null> | null = null;
let retryPromise: Promise<VoquillMigrationReport> | null = null;

const isClearStillSame = (generation: number): boolean =>
  !isLocalDataClearRequested() && getLocalDataClearGeneration() === generation;

const canApplyReportUpdate = (
  clearGeneration: number,
  requestSeq: number,
): boolean =>
  isClearStillSame(clearGeneration) &&
  isLatestVoquillMigrationRequestSeq(requestSeq);

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

  const clearGeneration = getLocalDataClearGeneration();
  const requestSeq = nextVoquillMigrationRequestSeq();
  produceAppState((draft) => {
    draft.voquillMigration.status = "loading";
    draft.voquillMigration.error = null;
  });

  const active = fetchVoquillMigrationStatus()
    .then((report) => {
      if (canApplyReportUpdate(clearGeneration, requestSeq)) {
        produceAppState((draft) => {
          draft.voquillMigration.report = report;
          draft.voquillMigration.status = "success";
          draft.voquillMigration.error = null;
        });
      }
      return report;
    })
    .catch((error) => {
      getLogger().warning(`Failed to load Voquill migration status: ${error}`);
      if (canApplyReportUpdate(clearGeneration, requestSeq)) {
        produceAppState((draft) => {
          draft.voquillMigration.status = "error";
          draft.voquillMigration.error =
            error instanceof Error ? error.message : String(error);
        });
      }
      return null;
    })
    .finally(() => {
      if (loadPromise === active) {
        loadPromise = null;
      }
    });

  loadPromise = active;
  return active;
};

const applyVoquillMigrationSuccess = (
  requestSeq: number,
  report: VoquillMigrationReport,
  clearFlag: "dismissing" | "retrying",
  resetApiKeys = false,
): void => {
  produceAppState((draft) => {
    if (isLatestVoquillMigrationRequestSeq(requestSeq)) {
      draft.voquillMigration.report = report;
      draft.voquillMigration.status = "success";
      draft.voquillMigration.error = null;
    }
    draft.voquillMigration[clearFlag] = false;
    if (resetApiKeys) {
      // Force API keys reload so the newly swapped migrated DB is hydrated.
      draft.settings.apiKeysStatus = "idle";
    }
  });
};

export const dismissVoquillMigration =
  async (): Promise<VoquillMigrationReport | null> => {
    if (getAppState().voquillMigration.dismissing) {
      return getAppState().voquillMigration.report;
    }

    const clearGeneration = getLocalDataClearGeneration();
    const requestSeq = nextVoquillMigrationRequestSeq();
    produceAppState((draft) => {
      draft.voquillMigration.dismissing = true;
      draft.voquillMigration.error = null;
    });

    try {
      const report = await withLocalDataWrite((lease) =>
        dismissVoquillMigrationNotice(lease),
      );
      if (isClearStillSame(clearGeneration)) {
        applyVoquillMigrationSuccess(requestSeq, report, "dismissing");
      }
      return report;
    } catch (error) {
      getLogger().warning(
        `Failed to dismiss Voquill migration notice: ${error}`,
      );
      if (isClearStillSame(clearGeneration)) {
        produceAppState((draft) => {
          draft.voquillMigration.dismissing = false;
          if (isLatestVoquillMigrationRequestSeq(requestSeq)) {
            draft.voquillMigration.error =
              error instanceof Error ? error.message : String(error);
          }
        });
      }
      return null;
    }
  };

const executeVoquillMigrationRetry = async (
  previousDatabasePhase: VoquillMigrationReport["databasePhase"] | undefined,
): Promise<VoquillMigrationReport> => {
  const clearGeneration = getLocalDataClearGeneration();
  const requestSeq = nextVoquillMigrationRequestSeq();
  produceAppState((draft) => {
    draft.voquillMigration.retrying = true;
    draft.voquillMigration.error = null;
  });

  try {
    const report = await withLocalDataWrite((lease) =>
      retryVoquillMigration(lease),
    );
    const dbPromoted =
      previousDatabasePhase !== "migrated" &&
      report.databasePhase === "migrated";

    if (isClearStillSame(clearGeneration)) {
      applyVoquillMigrationSuccess(requestSeq, report, "retrying", dbPromoted);
    }

    if (dbPromoted && isClearStillSame(clearGeneration)) {
      await Promise.allSettled([
        refreshCurrentUser(),
        loadApiKeys({ force: true }),
        loadHotkeys(),
        loadDictionary(),
        loadTones(),
        loadAppTargets(),
      ]);
    }

    return report;
  } catch (error) {
    getLogger().error(`Failed to retry Voquill migration: ${error}`);
    if (isClearStillSame(clearGeneration)) {
      produceAppState((draft) => {
        draft.voquillMigration.retrying = false;
        if (isLatestVoquillMigrationRequestSeq(requestSeq)) {
          draft.voquillMigration.error =
            error instanceof Error ? error.message : String(error);
        }
      });
    }
    throw error;
  }
};

export const runVoquillMigrationRetry = (): Promise<VoquillMigrationReport> => {
  if (retryPromise) {
    return retryPromise;
  }
  const previousDatabasePhase =
    getAppState().voquillMigration.report?.databasePhase;
  const active = executeVoquillMigrationRetry(previousDatabasePhase).finally(
    () => {
      if (retryPromise === active) {
        retryPromise = null;
      }
    },
  );
  retryPromise = active;
  return active;
};
