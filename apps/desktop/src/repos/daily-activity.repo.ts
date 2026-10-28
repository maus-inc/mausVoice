import { invoke } from "@tauri-apps/api/core";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import type { DailyWordActivity } from "../types/home.types";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export type { DailyWordActivity } from "../types/home.types";

export abstract class BaseDailyActivityRepo extends BaseRepo {
  abstract listDailyActivity(
    startDate: string,
    endDate: string,
    lease?: LocalDataWriteLease,
  ): Promise<DailyWordActivity[]>;
}

export class LocalDailyActivityRepo extends BaseDailyActivityRepo {
  listDailyActivity(
    startDate: string,
    endDate: string,
    lease?: LocalDataWriteLease,
  ): Promise<DailyWordActivity[]> {
    // The native read repairs missing aggregates, so clear must drain it too.
    return withLocalDataWrite(
      () =>
        invoke<DailyWordActivity[]>("daily_activity_list", {
          startDate,
          endDate,
        }),
      lease,
    );
  }
}
