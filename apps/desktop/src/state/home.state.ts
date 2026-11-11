import type {
  DailyActivityStatus,
  DailyWordActivity,
} from "../types/home.types";

export type HomeState = {
  dailyActivity: DailyWordActivity[];
  dailyActivityStatus: DailyActivityStatus;
};

export const INITIAL_HOME_STATE: HomeState = {
  dailyActivity: [],
  dailyActivityStatus: "idle",
};
