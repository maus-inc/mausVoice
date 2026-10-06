import { invoke } from "@tauri-apps/api/core";
import { BaseRepo } from "./base.repo";

export type DailyWordActivity = {
  localDate: string;
  wordCount: number;
};

export abstract class BaseDailyActivityRepo extends BaseRepo {
  abstract listDailyWordActivity(
    startDate: string,
    endDate: string,
  ): Promise<DailyWordActivity[]>;
}

export class LocalDailyActivityRepo extends BaseDailyActivityRepo {
  async listDailyWordActivity(
    startDate: string,
    endDate: string,
  ): Promise<DailyWordActivity[]> {
    return invoke<DailyWordActivity[]>("daily_activity_list", {
      startDate,
      endDate,
    });
  }
}
