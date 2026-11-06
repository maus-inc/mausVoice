import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { pushPillPlacementToNative } from "../actions/windows-sync.actions";
import { useAppStore } from "../store";
import { isWindows } from "../utils/env.utils";
import { getLogger } from "../utils/log.utils";
import { getMyUser, getMyUserPreferences } from "../utils/user.utils";

/** Mirror persisted audio feedback and placement to the process-global native pill. */
export function useNativeFeedbackSync(isMainWindow: boolean) {
  const playInteractionChime = useAppStore(
    (state) => getMyUser(state)?.playInteractionChime ?? true,
  );
  const interactionFeedbackVolume = useAppStore(
    (state) => getMyUser(state)?.interactionFeedbackVolume ?? 0.35,
  );
  const pillPlacement = useAppStore(
    (state) => getMyUserPreferences(state)?.pillPlacement ?? "bottom",
  );
  // A23: Keep the native thock gate in sync with the persisted
  // playInteractionChime preference (initial value + changes). The native
  // flag is process-global, so only the main window may write it — the
  // composer popout mounts this component too and would clobber the
  // setting with its fallback defaults.
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_interaction_chime_enabled", {
      enabled: playInteractionChime,
    }).catch(() => {
      // Best-effort mirror of the persisted preference; the store value
      // remains the source of truth and is re-sent on the next change.
    });
  }, [isMainWindow, playInteractionChime]);

  // Mirror the user-chosen thock gain into Rust so the warm path AND the
  // fallback path apply the live volume. Main-window-only for the same
  // process-global reason as the chime gate above.
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_interaction_feedback_volume", {
      volume: interactionFeedbackVolume,
    }).catch(() => {
      // Best-effort mirror of the persisted preference; the store value
      // remains the source of truth and is re-sent on the next change.
    });
  }, [isMainWindow, interactionFeedbackVolume]);

  // The native Windows pill starts bottom-anchored in its static cell, so the
  // persisted pillPlacement must be pushed on mount AND on change. Without
  // the mount push a "top" user sees the pill fall back to bottom after every
  // restart until they toggle the setting again. Windows-only: the macOS
  // overlay ignores placement and the GTK pill protocol has no placement
  // message. Main-window-only for the same process-global reason as above.
  useEffect(() => {
    if (!isMainWindow || !isWindows()) return;
    pushPillPlacementToNative(pillPlacement).catch((error: unknown) => {
      getLogger().warning(
        `Failed to push pill placement to native pill: ${error}`,
      );
    });
  }, [isMainWindow, pillPlacement]);
}
