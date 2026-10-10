import { invoke } from "@tauri-apps/api/core";
import type { DailyWordActivity } from "../types/home.types";
import { BaseRepo } from "./base.repo";

export type { DailyWordActivity } from "../types/home.types";

export abstract class BaseDailyActivityRepo extends BaseRepo {
  abstract listDailyActivity(
    startDate: string,
    endDate: string,
  ): Promise<DailyWordActivity[]>;
}

export class LocalDailyActivityRepo extends BaseDailyActivityRepo {
  async listDailyActivity(
    startDate: string,
    endDate: string,
  ): Promise<DailyWordActivity[]> {
    return invoke<DailyWordActivity[]>("daily_activity_list", {
      startDate,
      endDate,
    });
  }
}
