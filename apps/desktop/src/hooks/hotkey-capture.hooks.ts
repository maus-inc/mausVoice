import { useEffect } from "react";
import type { AppState } from "../state/app.state";
import { produceAppState } from "../store";
import { createId } from "../utils/id.utils";

// Effect lifetimes are not part of a replaceable or rehydrated store snapshot.
// The store array is a notification/mirror, not the authority for live owners.
const captureOwners = new Set<string>();

export const isHotkeyCaptureActive = (_state: AppState): boolean =>
  captureOwners.size > 0;

export function useHotkeyCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const owner = createId();
    captureOwners.add(owner);
    try {
      produceAppState((draft) => {
        draft.hotkeyCaptureOwnerIds.push(owner);
      });
    } catch (error) {
      // A failed setup cannot return an effect cleanup to release this owner.
      captureOwners.delete(owner);
      throw error;
    }
    return () => {
      captureOwners.delete(owner);
      produceAppState((draft) => {
        draft.hotkeyCaptureOwnerIds = draft.hotkeyCaptureOwnerIds.filter(
          (id) => id !== owner,
        );
      });
    };
  }, [active]);
}
