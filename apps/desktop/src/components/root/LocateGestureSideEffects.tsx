import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { getAppState, useAppStore } from "../../store";
import type { AppState } from "../../state/app.state";
import {
  createLocateGestureDetector,
  type LocateGestureDetector,
} from "../../utils/locate-gesture.utils";
import { sendPillLocate } from "../../utils/overlay.utils";

/** Applies one held-key snapshot to the detector and reports whether it fired. */
const applyKeysHeld = (
  state: AppState,
  detector: LocateGestureDetector,
  previousKeys: string[],
): { fired: boolean; keys: string[] } => {
  const selected = state.userPrefs?.pillLocateGestureModifier ?? "none";
  const active = state.hotkeyStrategy === "listener" && selected !== "none";
  if (!active) {
    detector.reset();
    return { fired: false, keys: state.keysHeld };
  }
  if (state.keysHeld === previousKeys) {
    return { fired: false, keys: previousKeys };
  }
  const fired = detector.update(state.keysHeld, performance.now(), selected);
  return { fired, keys: state.keysHeld };
};

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

    const unsubscribe = useAppStore.subscribe((state) => {
      const next = applyKeysHeld(state, detector, previousKeys);
      previousKeys = next.keys;
      if (next.fired) {
        sendPillLocate();
      }
    });

    return unsubscribe;
  }, []);

  return null;
};
