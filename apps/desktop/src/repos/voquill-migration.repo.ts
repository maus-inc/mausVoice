import {
  commands,
  type VoquillMigrationReport,
} from "@maus-inc/desktop-native-apis";
import { withLocalDataWrite } from "./base.repo";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";

export const fetchVoquillMigrationStatus =
  async (): Promise<VoquillMigrationReport> => {
    const result = await commands.voquillMigrationStatus();
    if (result.status === "error") {
      throw new Error(result.error);
    }
    return result.data;
  };

export const dismissVoquillMigrationNotice =
  async (): Promise<VoquillMigrationReport> => {
    const result = await commands.voquillMigrationDismiss();
    if (result.status === "error") {
      throw new Error(result.error);
    }
    return result.data;
  };

export const retryVoquillMigration = (
  lease?: LocalDataWriteLease,
): Promise<VoquillMigrationReport> =>
  withLocalDataWrite(async () => {
    const result = await commands.voquillMigrationRetry();
    if (result.status === "error") {
      throw new Error(result.error);
    }
    return result.data;
  }, lease);
