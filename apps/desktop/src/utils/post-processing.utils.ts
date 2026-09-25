import type { AppState } from "../state/app.state";
import {
  canApplyFastStyle,
  canApplyFastStyleForProvider,
} from "./fast-style.utils";
import { getGenerativePrefs } from "./user.utils";

/** Whether the configured LLM post-processing provider can actually be used. */
export const isPostProcessingEnabled = (state: AppState): boolean =>
  getGenerativePrefs(state).mode !== "none";

/**
 * Whether style selection should be shown.
 * Styles are available even when LLM is off via fast local transform.
 */
export const isStyleSelectionAvailable = (_state: AppState): boolean => {
  return true;
};

/** Whether the current mode will use fast local path (LLM off). */
export const isUsingFastPostProcessing = (state: AppState): boolean =>
  getGenerativePrefs(state).mode === "none";

/** Whether fast styling can be applied for a given tone. */
export const isFastStylingApplicable = (toneId: string | null): boolean => {
  return canApplyFastStyle(toneId);
};

export const isFastStylingApplicableForProvider = (
  provider: string | null,
  toneId: string | null,
): boolean => {
  return canApplyFastStyleForProvider(provider, toneId);
};

/**
 * Get the effective post-processing mode for display/telemetry.
 */
export const getEffectivePostProcessingModeForDisplay = (
  state: AppState,
  toneId: string | null,
): "api" | "fast" | "none" => {
  if (isPostProcessingEnabled(state)) return "api";
  if (isFastStylingApplicable(toneId)) return "fast";
  return "none";
};
