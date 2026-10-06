import type { DailyWordActivity } from "../../repos/daily-activity.repo";

export type ActivityLoadStatus = "loading" | "ready" | "error";

export type HomeActivityState = {
  status: ActivityLoadStatus;
  records: DailyWordActivity[];
  startDate: string;
  endDate: string;
  /** True after at least one successful query, including an empty result. */
  hasLoaded: boolean;
};
