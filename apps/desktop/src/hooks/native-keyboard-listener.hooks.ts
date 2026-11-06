import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import type {
  AppState,
  HotkeyStrategy,
  KeyboardListenerHealth,
} from "../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../store";
import { getEffectiveStylingMode } from "../utils/feature.utils";
import { syncHotkeyCombosToNative } from "../utils/keyboard.utils";
import { getLogger } from "../utils/log.utils";
import { getIsDictationUnlocked } from "../utils/user.utils";
import { useAsyncEffect } from "./async.hooks";

/**
 * Fingerprint of every state input that decides which combos the native
 * listener grabs (the combo maps themselves plus everything `isActionGrabbable`
 * reads). Those inputs load in an arbitrary order — hotkeys repo, onboarding /
 * user record, strategy probe — so a sync keyed to only one or two of them can
 * leave the listener running on an empty or stale combo set, which is exactly
 * how the global hotkey "stops working" after startup.
 */
const hotkeyGrabFingerprint = (state: AppState): string => {
  const hotkeyKey = Object.values(state.hotkeyById)
    .map((hotkey) => `${hotkey.actionName}:${hotkey.keys.join("+")}`)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  return [
    state.hotkeyStrategy ?? "",
    state.activeRecordingMode ?? "",
    getIsDictationUnlocked(state) ? "1" : "0",
    getEffectiveStylingMode(state),
    hotkeyKey,
  ].join("|");
};

/** Main-window owner of native listener startup and grab-set synchronization. */
export function useNativeKeyboardListener({
  isMainWindow,
  hotkeyStrategy,
  keyPermAuthorized,
}: {
  isMainWindow: boolean;
  hotkeyStrategy: HotkeyStrategy | null;
  keyPermAuthorized: boolean;
}) {
  useAsyncEffect(
    async (isCancelled) => {
      if (hotkeyStrategy !== "listener") {
        return;
      }
      // Only the main window owns the global key grab.
      if (!isMainWindow) {
        return;
      }

      if (keyPermAuthorized) {
        getLogger().info(
          "Accessibility permission authorized, starting key listener",
        );
        await invoke("start_key_listener");
      } else {
        getLogger().info(
          "Accessibility permission not authorized, stopping key listener",
        );
        await invoke("stop_key_listener");
      }

      if (isCancelled()) return;

      // Seed health from the current value: transition events emitted before the
      // `keyboard_listener_health` subscription was registered would otherwise be missed,
      // leaving the store stuck at its initial "stopped".
      try {
        const health = await invoke<KeyboardListenerHealth>(
          "get_key_listener_health",
        );
        if (!isCancelled()) {
          produceAppState((draft) => {
            draft.keyboardListenerHealth = health;
          });
        }
      } catch (error) {
        getLogger().warning(
          `Failed to read keyboard listener health: ${error}`,
        );
      }
    },
    [keyPermAuthorized, hotkeyStrategy, isMainWindow],
  );

  // Keep the native grab set in lockstep with the state it derives from. The
  // push is gated on the strategy being known so the compositor (bridge) branch
  // of the sync never runs half-configured, and re-runs whenever any
  // grab-relevant input changes — regardless of data load order.
  useEffect(() => {
    // Native hotkey grab sync is owned by the main window only.
    if (!isMainWindow) {
      return;
    }
    const push = () => {
      if (getAppState().hotkeyStrategy) {
        // syncHotkeyCombosToNative rejects if the native grab fails to install
        // (e.g. bridge not ready); swallow it so it doesn't become an unhandled
        // promise rejection that crashes the effect's subscription.
        syncHotkeyCombosToNative().catch((err) => {
          console.warn("[AppSideEffects] hotkey sync failed", err);
        });
      }
    };

    push();

    let lastFingerprint = hotkeyGrabFingerprint(getAppState());
    return useAppStore.subscribe((state) => {
      const next = hotkeyGrabFingerprint(state);
      if (next === lastFingerprint) {
        return;
      }
      lastFingerprint = next;
      push();
    });
  }, [isMainWindow]);
}
