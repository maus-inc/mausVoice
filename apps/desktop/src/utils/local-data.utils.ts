import { invoke } from "@tauri-apps/api/core";
import { INITIAL_LOCAL_STATE } from "../state/local.state";
import { produceAppState } from "../store";
import { getLogger } from "./log.utils";
import { clearAppDataStorage } from "./local-storage.utils";

/**
 * Remove this device's copy of the app's data.
 *
 * Two flows promise to remove local data — "Clear local data" and deleting the
 * account — and they have to remove the same things. When each did it on its
 * own, the account-deletion flow wiped the database and the audio but left
 * localStorage alone, so the profile photo (a picture of the person's face,
 * stored as a data URL) survived the deletion that promised to erase it. The
 * steps are here once so a third flow cannot half-copy them.
 *
 * What is wiped, and why each part is needed:
 *
 * 1. Long-running native subsystems are stopped first. A recorder or global key
 *    listener left running past `clear_local_data` races its own callbacks
 *    against a now-empty database and reports errors into the session that
 *    follows.
 * 2. `clear_local_data` removes the database and the managed audio directory.
 * 3. The in-memory local slice is reset *before* storage is cleared, because
 *    the persist middleware rewrites its own key on every state change: a slice
 *    still holding the photo would be written straight back out by the next
 *    state change, undoing step 4.
 * 4. The app's own localStorage keys go last. Background windows, dismissed
 *    tips and the profile photo live there, and none of them are inside the
 *    database the native wipe empties.
 *
 * Session credentials are deliberately untouched: clearing local data is not a
 * sign-out, and the account-deletion flow signs out on its own terms.
 */
export type LocalDataWipe = {
  /**
   * localStorage keys the browser refused to remove. Empty on success. Callers
   * decide what to tell the person; this function does not report its own
   * failures, because it has no opinion about whether the wipe was the point of
   * the flow (it is, for clearing) or a step inside a larger one (deletion).
   */
  storageFailedKeys: string[];
};

/** The native commands that stop work that could race the wipe. */
const STOP_COMMANDS = ["stop_key_listener", "stop_recording"] as const;

const stopNativeSubsystems = async (): Promise<void> => {
  for (const command of STOP_COMMANDS) {
    try {
      await invoke(command);
    } catch {
      // Best effort: there may be nothing running to stop. The command is
      // absent on some platforms and errors when no session is live, and
      // neither is a reason to abandon a wipe the person asked for.
    }
  }
};

export const clearLocalData = async (): Promise<LocalDataWipe> => {
  getLogger().info("Clearing local data on this device");
  await stopNativeSubsystems();
  await invoke("clear_local_data");
  produceAppState((draft) => {
    draft.local = INITIAL_LOCAL_STATE;
  });
  return { storageFailedKeys: clearAppDataStorage() };
};
