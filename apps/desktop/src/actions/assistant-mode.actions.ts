import { ASSISTANT_MODE_SETTINGS_PATH } from "../components/settings/settings-routes";
import { produceAppState } from "../store";
import { navigateApp } from "../utils/app-navigation";
import { getLogger } from "../utils/log.utils";
import { surfaceMainWindowDetached } from "../utils/window.utils";

/**
 * Sends someone to the row that turns Assistant mode on.
 *
 * Every surface that used to open an assistant feature it could not deliver
 * lands here, so the destination is spelled once and the highlight comes from
 * the settings layout's own anchor rather than from a dialog that only exists
 * on the settings pages.
 */
export const openAssistantModeSettings = (): void => {
  surfaceMainWindowDetached();
  navigateApp(ASSISTANT_MODE_SETTINGS_PATH).catch((error: unknown) => {
    getLogger().warning(
      `Failed to open the assistant mode setting: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
};

/**
 * Runs `onEnabled` when Assistant mode is on, and otherwise opens the setting
 * that turns it on.
 *
 * This is the guard for an entry point whose whole job is an assistant
 * conversation. With the switch off, opening the conversation is a dead end
 * the person cannot finish from where they land, so the honest answer is the
 * setting. Callers that have their own reason to stay put pass their own
 * fallback instead.
 *
 * `onDisabled` runs before the navigation. A key that would have opened a chat
 * window also stops whatever that window was going to interrupt — leaving a
 * recording running while the person reads a settings page is a state they
 * cannot see and did not ask for — and the action that ran on the enabled path
 * owns that teardown, so the caller hands its equivalent here.
 */
export const withAssistantMode = (
  isEnabled: boolean,
  onEnabled: () => void,
  onDisabled?: () => void,
): void => {
  if (isEnabled) {
    onEnabled();
    return;
  }
  onDisabled?.();
  openAssistantModeSettings();
};

/**
 * Opens the in-window Assistant mode dialog, for a surface that is already
 * inside Settings.
 *
 * `AIAgentModeDialog` is mounted once in the settings root, so a caller
 * anywhere else that set this flag would change state and show nothing.
 */
export const openAssistantModeDialog = (): void => {
  produceAppState((draft) => {
    draft.settings.agentModeDialogOpen = true;
  });
};
