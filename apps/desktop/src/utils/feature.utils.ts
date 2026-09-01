import { StylingMode } from "@maus-inc/types";
import { AppState } from "../state/app.state";
import { getMyUser } from "./user.utils";

export const CURRENT_FEATURE_DATE = new Date("2026-08-15").toISOString();

export const getEffectiveStylingMode = (state: AppState): StylingMode => {
  const user = getMyUser(state);
  return user?.stylingMode ?? "app";
};
