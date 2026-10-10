import type { AppState } from "../state/app.state";
import { getGenerativePrefs } from "./user.utils";

/** Whether the configured LLM post-processing provider can actually be used. */
export const isPostProcessingEnabled = (state: AppState): boolean =>
  getGenerativePrefs(state).mode !== "none";

/**
 * Whether style selection should be shown. Always true: a style is applied by
 * the deterministic local transform when no LLM provider is configured, and by
 * the LLM when one is, so there is no state in which picking a style is inert.
 */
export const isStyleSelectionAvailable = (_state: AppState): boolean => true;
