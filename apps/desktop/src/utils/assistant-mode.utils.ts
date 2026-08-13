import { AppState } from "../state/app.state";

export const ASSISTANT_MODE_ENABLED_KEY = "mausvoice:assistant-mode-enabled";
export const POWER_MODE_ENABLED_KEY = "mausvoice:power-mode-enabled";

export const getIsAssistantModeEnabled = (state: AppState): boolean => {
  return state.local.assistantModeEnabled;
};

export const getIsPowerModeEnabled = (state: AppState): boolean => {
  return state.local.powerModeEnabled;
};
