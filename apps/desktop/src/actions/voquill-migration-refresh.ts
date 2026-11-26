import { fetchVoquillMigrationStatus } from "../repos/voquill-migration.repo";
import { getAppState, produceAppState } from "../store";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../utils/local-data-write-gate";
import { getLogger } from "../utils/log.utils";

let latestReportRequestSeq = 0;

/**
 * Claims the next monotonic sequence number for any operation that writes
 * `voquillMigration.report` (load, silent refresh, dismiss, or retry).
 *
 * Shared from this leaf module so every writer discards out-of-order responses
 * started before a newer request without introducing a circular dependency.
 */
export const nextVoquillMigrationRequestSeq = (): number => {
  latestReportRequestSeq += 1;
  return latestReportRequestSeq;
};

export const isLatestVoquillMigrationRequestSeq = (seq: number): boolean =>
  seq === latestReportRequestSeq;

/**
 * Refreshes the migration report silently when a legacy Voquill profile was
 * detected, so re-entering or deleting an unreadable API key immediately clears
 * the action-needed state across Home and Privacy & Data settings.
 *
 * Lives in its own leaf module so `api-key.actions.ts` can trigger a refresh
 * without introducing a circular dependency with `voquill-migration.actions.ts`.
 */
export const refreshVoquillMigrationStatusIfActive =
  async (): Promise<void> => {
    if (
      isLocalDataClearRequested() ||
      !getAppState().voquillMigration.report?.legacyDetected
    ) {
      return;
    }
    const clearGeneration = getLocalDataClearGeneration();
    const requestSeq = nextVoquillMigrationRequestSeq();
    try {
      const report = await fetchVoquillMigrationStatus();
      if (
        isLocalDataClearRequested() ||
        getLocalDataClearGeneration() !== clearGeneration ||
        !isLatestVoquillMigrationRequestSeq(requestSeq)
      ) {
        return;
      }
      produceAppState((draft) => {
        draft.voquillMigration.report = report;
        draft.voquillMigration.status = "success";
        draft.voquillMigration.error = null;
      });
    } catch (error) {
      getLogger().warning(
        `Failed to refresh Voquill migration status: ${error}`,
      );
    }
  };
