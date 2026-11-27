import { getHotkeyRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { registerHotkeys } from "../utils/app.utils";
import { syncHotkeyCombosToNative } from "../utils/keyboard.utils";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../utils/local-data-write-gate";
import { showErrorSnackbar } from "./app.actions";

let loadHotkeysGeneration = 0;

export const loadHotkeys = async (): Promise<void> => {
  const clearGeneration = getLocalDataClearGeneration();
  const isClearStillSame = () =>
    !isLocalDataClearRequested() &&
    clearGeneration === getLocalDataClearGeneration();

  if (!isClearStillSame()) {
    return;
  }

  loadHotkeysGeneration += 1;
  const generation = loadHotkeysGeneration;
  const isCurrentLoad = () =>
    generation === loadHotkeysGeneration && isClearStillSame();

  produceAppState((draft) => {
    draft.settings.hotkeysStatus = "loading";
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
    if (
      generation === loadHotkeysGeneration &&
      getAppState().settings.hotkeysStatus === "loading"
    ) {
      produceAppState((draft) => {
        if (draft.settings.hotkeysStatus === "loading") {
          draft.settings.hotkeysStatus = "idle";
        }
      });
    }
  }
};
