import { invoke } from "@tauri-apps/api/core";
import {
  checkForAppUpdates,
  openUpdateDialog,
} from "../actions/updater.actions";
import { getTranscriptionRepo } from "../repos";
import { getIsDevMode } from "../utils/env.utils";
import { getLogger } from "../utils/log.utils";
import { hoursToMilliseconds } from "../utils/time.utils";
import { surfaceMainWindow } from "../utils/window.utils";
import { useIntervalAsync } from "./helper.hooks";
import { useTauriListen } from "./tauri.hooks";

const UPDATE_CHECK_INTERVAL_MS = hoursToMilliseconds(6);

/** Periodic updates and tray actions are owned by the main window. */
export function useAppTrayActions(isMainWindow: boolean) {
  // Background update poll. Releases land a few times a year, so a slow
  // cadence is plenty; the Settings "Check now" button covers impatience.
  useIntervalAsync(UPDATE_CHECK_INTERVAL_MS, async () => {
    if (!isMainWindow) {
      return;
    }

    // Dev builds run against an unsigned local bundle the updater endpoint
    // knows nothing about, so a check can only ever produce noise.
    if (getIsDevMode()) {
      return;
    }

    // The action syncs the tray badge itself, so a manual check from Settings
    // updates it too rather than waiting for the next poll.
    await checkForAppUpdates();
  }, [isMainWindow]);

  useTauriListen<void>("tray-install-update", () => {
    if (!isMainWindow) return;
    // Route through the dialog rather than installing straight from the tray.
    // The dialog is the only surface that shows the release notes before an
    // update applies, so installing from here would make the notes unreachable
    // for anyone who never opens the update entry point. `openUpdateDialog`
    // reuses a live offer and falls back to a fresh check when none is held.
    // Fire-and-forget: the listener body is not async, so it never receives the
    // promise. The `.catch` is what keeps a failed check from becoming an
    // unhandled rejection.
    void surfaceMainWindow();
    void openUpdateDialog().catch((error: unknown) => {
      getLogger().error(`Failed to open the update dialog: ${error}`);
    });
  });

  useTauriListen<void>("tray-copy-last-transcript", async () => {
    if (!isMainWindow) return;
    const [latest] = await getTranscriptionRepo().listTranscriptions({
      limit: 1,
    });
    if (latest?.transcript) {
      await invoke("copy_to_clipboard", { text: latest.transcript });
    }
  });
}
