import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { getAppState, useAppStore } from "../../store";
import { createLocateGestureDetector } from "../../utils/locate-gesture.utils";
import { sendPillLocate } from "../../utils/overlay.utils";

/**
 * Watches the held-key stream the native listener already publishes and asks
 * the pill to replay its outline when the person double-taps a modifier.
 *
 * This subscribes to the store instead of reading a render snapshot, so a fast
 * press, release, press sequence cannot be collapsed between renders.
 */
export const LocateGestureSideEffects = () => {
  useEffect(() => {
    if (getCurrentWindow().label !== "main") {
      return;
    }

    const detector = createLocateGestureDetector();
    let previousKeys = getAppState().keysHeld;

    return useAppStore.subscribe((state) => {
      const selected = state.userPrefs?.pillLocateGestureModifier ?? "none";
      const active = state.hotkeyStrategy === "listener" && selected !== "none";
      if (!active) {
        detector.reset();
        previousKeys = state.keysHeld;
        return;
      }
      if (state.keysHeld === previousKeys) {
        return;
      }
      previousKeys = state.keysHeld;
      if (detector.update(state.keysHeld, performance.now(), selected)) {
        sendPillLocate();
      }
      return undefined;
    });
  }, []);

  return null;
};
