import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import type { ActionStatus } from "../types/state.types";

export type VoquillMigrationState = {
  report: VoquillMigrationReport | null;
  status: ActionStatus;
  retrying: boolean;
  dismissing: boolean;
  dismissFailed: boolean;
  error: string | null;
};

export const INITIAL_VOQUILL_MIGRATION_STATE: VoquillMigrationState = {
  report: null,
  status: "idle",
  retrying: false,
  dismissing: false,
  dismissFailed: false,
  error: null,
};
