import { isEqual } from "lodash-es";
import { useCallback, useEffect, useRef } from "react";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { getAppState, produceAppState } from "../../store";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "../../utils/permission.utils";

// Permission state only changes outside the app (system settings), so a slow
// poll while visible is plenty; the interval hook additionally pauses the poll
// outright while the window is hidden and re-checks on return.
const PERMISSION_POLL_INTERVAL_MS = 2_500;

export const PermissionSideEffects = () => {
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);

  const refreshPermissions = useCallback(async () => {
    if (checkingRef.current) {
      return;
    }

    checkingRef.current = true;
    try {
      const [microphone, accessibility] = await Promise.all([
        checkMicrophonePermission().catch((error) => {
          console.error("Failed to fetch microphone permission", error);
          return null;
        }),
        checkAccessibilityPermission().catch((error) => {
          console.error("Failed to fetch accessibility permission", error);
          return null;
        }),
      ]);

      if (mountedRef.current) {
        // Enum strings barely ever change; skip the produce when nothing did
        // so the poll doesn't churn store updates (and subscribers) 24/7.
        const current = getAppState().permissions;
        if (
          isEqual(current.microphone, microphone) &&
          isEqual(current.accessibility, accessibility)
        ) {
          return;
        }
        produceAppState((draft) => {
          draft.permissions.microphone = microphone;
          draft.permissions.accessibility = accessibility;
        });
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshPermissions();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshPermissions]);

  useIntervalAsync(PERMISSION_POLL_INTERVAL_MS, refreshPermissions, [
    refreshPermissions,
  ]);

  return null;
};
