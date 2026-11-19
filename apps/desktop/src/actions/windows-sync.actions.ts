import { invoke } from "@tauri-apps/api/core";
import type { PillPlacement } from "@maus-inc/types";

/**
 * Re-registers the global keyboard hook after a Windows sleep/wake or
 * session-unlock transition.
 *
 * `rdev::grab` installs a low-level hook that the OS tears down across those
 * boundaries. The Rust lifecycle watcher emits `desktop_resume`; this action
 * is the frontend half of that handshake: it only restarts when the listener
 * strategy is active, the caller is the main window (which owns the grab),
 * and the accessibility permission is still authorized.
 *
 * Returns true when a restart was issued, false when the gating conditions
 * were not met so the caller can distinguish "handled" from "nothing to do".
 */
export const restartKeyboardListenerOnResume = async (args: {
  hotkeyStrategy: "listener" | "bridge" | null;
  isMainWindow: boolean;
  keyPermAuthorized: boolean;
}): Promise<boolean> => {
  if (
    args.hotkeyStrategy !== "listener" ||
    !args.isMainWindow ||
    !args.keyPermAuthorized
  ) {
    return false;
  }
  await invoke("restart_key_listener");
  return true;
};

/**
 * Push the persisted pill anchor preference to the native pill process.
 *
 * The Windows pill starts bottom-anchored (`PILL_PLACEMENT_BOTTOM`) in its
 * static cell, so without this the "top" preference survives in the database
 * but is silently ignored after every app restart until the user toggles the
 * setting again. Windows-only: the macOS overlay ignores placement and the
 * GTK pill protocol has no placement message.
 */
export const pushPillPlacementToNative = async (
  placement: PillPlacement,
): Promise<void> => {
  await invoke("set_pill_placement", { placement });
};
