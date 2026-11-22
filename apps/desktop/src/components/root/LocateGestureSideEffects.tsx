import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { locatePill } from "../../actions/native.actions";
import { useAppStore } from "../../store";
import type { AppState } from "../../state/app.state";
import {
  createLocateGestureDetector,
  type LocateGestureDetector,
} from "../../utils/locate-gesture.utils";

/**
 * Applies one store snapshot to the detector and reports whether it fired.
 *
 * Every snapshot is fed, not just the ones where the held keys changed: the
 * preference can move to another modifier while one is still held, and no key
 * event arrives to notice it. The detector drops the sequence when the family
 * it is watching stops being the selected one.
 */
const applyState = (
  state: AppState,
  detector: LocateGestureDetector,
): boolean => {
  const selected = state.userPrefs?.pillLocateGestureModifier ?? "none";
  if (state.hotkeyStrategy !== "listener" || selected === "none") {
    detector.reset();
    return false;
  }
  return detector.update(state.keysHeld, performance.now(), selected);
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

    const unsubscribe = useAppStore.subscribe((state) => {
      if (applyState(state, detector)) {
        // The action handles its own failure; nothing here needs the promise.
        void locatePill();
      }
    });

    return unsubscribe;
  }, []);

  return null;
};
