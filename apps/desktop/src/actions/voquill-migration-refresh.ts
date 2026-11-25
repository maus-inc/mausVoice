import { fetchVoquillMigrationStatus } from "../repos/voquill-migration.repo";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";

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
    if (!getAppState().voquillMigration.report?.legacyDetected) {
      return;
    }
    try {
      const report = await fetchVoquillMigrationStatus();
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
