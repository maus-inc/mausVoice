import { isEqual } from "lodash-es";
import { getAppState, produceAppState } from "../store";
import {
  evaluateHotkeyTrigger,
  releaseHotkey,
} from "../utils/hotkey-filter.utils";
import { getStyleSwitchActionNamesForKey } from "../utils/keyboard.utils";
import { getLogger } from "../utils/log.utils";
import { useTauriListen } from "./tauri.hooks";

type BridgeHotkeyTriggerPayload = { hotkey: string };
type KeysHeldPayload = { keys: string[] };

/** The bridge and held-key events share the main window's physical key state. */
export function useHotkeyInputEvents(isMainWindow: boolean) {
  useTauriListen<BridgeHotkeyTriggerPayload>(
    "bridge_hotkey_trigger",
    (payload) => {
      // A21: Filter hotkey spam while the pill is in an active recording state.
      // Repeated identical triggers are debounced; stop/cancel always pass.
      // This must happen BEFORE the counter increment so consumers never see
      // a filtered trigger.
      const isRecording = getAppState().overlayPhase === "recording";
      const { allowed, reason } = evaluateHotkeyTrigger(
        payload.hotkey,
        isRecording,
      );
      if (!allowed) {
        getLogger().verbose(
          `[hotkey-filter] blocked ${payload.hotkey}: ${reason}`,
        );
        return;
      }
      produceAppState((draft) => {
        draft.hotkeyTriggers[payload.hotkey] =
          (draft.hotkeyTriggers[payload.hotkey] ?? 0) + 1;
      });
    },
  );

  useTauriListen<KeysHeldPayload>("keys_held", (payload) => {
    // Only the main window owns dictation input; ignore held-key updates in
    // the composer popout (and any other webview) so its SPA copy can't drive
    // a duplicate dictation/style-switch pipeline.
    if (!isMainWindow) {
      return;
    }
    const existing = getAppState().keysHeld;
    if (isEqual(existing, payload.keys)) {
      return;
    }

    // A21: Release a style-switch action's "held" state when its physical key
    // is released. Releasing only when ALL keys are up would never fire during
    // hold-to-talk dictation (the dictate key stays held), wedging style
    // switching after the first press.
    const releasedKeys = existing.filter(
      (key) =>
        !payload.keys.some((held) => held.toLowerCase() === key.toLowerCase()),
    );
    if (releasedKeys.length > 0) {
      for (const key of releasedKeys) {
        for (const actionName of getStyleSwitchActionNamesForKey(
          getAppState(),
          key,
        )) {
          releaseHotkey(actionName);
        }
      }
    }

    produceAppState((draft) => {
      draft.keysHeld = payload.keys;
    });
  });
}
