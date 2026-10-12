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

/**
 * Stop the native subsystems that could race the wipe, and report whether any
 * refused.
 *
 * The commands are idempotent: `stop_recording` answers with an empty result
 * when no recording is running and `stop_key_listener` returns Ok when there is
 * no listener (`stop_key_listener_is_idempotent` in `platform/keyboard.rs`
 * covers that), so "nothing was running" is a success, not an error. A
 * rejection is therefore a recorder that is still live, and the person asking
 * for a wipe needs to hear about it. The wipe still runs — the parts that
 * cannot be undone should not wait on the part that can be retried — but the
 * refusal is carried out of here and reported at the end.
 */
const stopNativeSubsystems = async (): Promise<unknown | null> => {
  const outcomes = await Promise.all(
    STOP_COMMANDS.map(async (command) => {
      try {
        await invoke(command);
        return null;
      } catch (error) {
        getLogger().error(
          `Failed to ${command} before clearing data: ${error}`,
        );
        return error;
      }
    }),
  );
  return outcomes.find((outcome) => outcome !== null) ?? null;
};

export const clearLocalData = async (): Promise<LocalDataWipe> => {
  getLogger().info("Clearing local data on this device");
  const stopFailure = await stopNativeSubsystems();

  // The native wipe can fail part-way through — the audio cleanup is the
  // usual way — and that failure must not stop the steps below. The profile
  // photo lives in localStorage, not in the database the native side drops,
  // so returning early is how a deletion the person asked for ends with a
  // picture of their face still on disk. The failure is remembered, logged,
  // and rethrown once everything else has run: the caller still reports that
  // the wipe was not complete.
  let nativeFailure: unknown;
  try {
    await invoke("clear_local_data");
  } catch (error) {
    nativeFailure = error;
    getLogger().error(`Failed to clear native local data: ${error}`);
  }

  produceAppState((draft) => {
    draft.local = INITIAL_LOCAL_STATE;
  });
  const storageFailedKeys = clearAppDataStorage();

  // Both failures mean the same thing to the caller — the wipe is not
  // complete — and the native one happened first, so it is the one thrown.
  if (nativeFailure) {
    throw nativeFailure;
  }
  if (stopFailure) {
    throw stopFailure;
  }
  return { storageFailedKeys };
};
