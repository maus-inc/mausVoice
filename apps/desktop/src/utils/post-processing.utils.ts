import type { AppState } from "../state/app.state";
import { getGenerativePrefs } from "./user.utils";

/** Whether the configured post-processing provider can actually be used. */
export const isPostProcessingEnabled = (state: AppState): boolean =>
  getGenerativePrefs(state).mode !== "none";
