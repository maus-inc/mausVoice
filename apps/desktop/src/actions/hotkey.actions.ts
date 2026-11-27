import { getHotkeyRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { registerHotkeys } from "../utils/app.utils";
import { syncHotkeyCombosToNative } from "../utils/keyboard.utils";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../utils/local-data-write-gate";
import { showErrorSnackbar } from "./app.actions";

export const loadHotkeys = async (): Promise<void> => {
  const clearGeneration = getLocalDataClearGeneration();
  const isClearStillSame = () =>
    !isLocalDataClearRequested() &&
    clearGeneration === getLocalDataClearGeneration();

  if (!isClearStillSame()) {
    return;
  }

  const requestId = crypto.randomUUID();
  const isCurrentRequest = () =>
    getAppState().settings.hotkeysRequestId === requestId;
  const isCurrentLoad = () => isCurrentRequest() && isClearStillSame();

  produceAppState((draft) => {
    draft.settings.hotkeysStatus = "loading";
    draft.settings.hotkeysRequestId = requestId;
  });

  try {
    const hotkeys = await getHotkeyRepo().listHotkeys();
    if (!isCurrentLoad()) {
      return;
    }
    produceAppState((draft) => {
      registerHotkeys(draft, hotkeys);
      draft.settings.hotkeyIds = hotkeys.map((hotkey) => hotkey.id);
      draft.settings.hotkeysStatus = "success";
    });
    if (!isCurrentLoad()) {
      return;
    }
    await syncHotkeyCombosToNative();
  } catch (error) {
    if (!isCurrentLoad()) {
      return;
    }
    console.error("Failed to load hotkeys", error);
    produceAppState((draft) => {
      draft.settings.hotkeysStatus = "error";
    });
    showErrorSnackbar("Failed to load hotkeys. Please try again.");
  } finally {
    if (isCurrentRequest()) {
      produceAppState((draft) => {
        if (draft.settings.hotkeysRequestId === requestId) {
          draft.settings.hotkeysRequestId = null;
          if (draft.settings.hotkeysStatus === "loading") {
            draft.settings.hotkeysStatus = "idle";
          }
        }
      });
    }
  }
};
