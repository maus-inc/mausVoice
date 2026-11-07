import { useCallback, useEffect, useRef } from "react";
import { commands } from "@maus-inc/desktop-native-apis";
import { produceAppState, useAppStore } from "../../store";
import { getAppState } from "../../store";
import { getLogger } from "../../utils/log.utils";
import {
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import {
  MICROPHONE_READY_FOREVER_MS,
  shouldHoldMicrophoneReady,
  shouldPrepareMicrophone,
} from "../../utils/microphone-readiness.utils";
import { isPermissionAuthorized } from "../../utils/permission.utils";

/**
 * Keeps the capture device in step with the "keep microphone ready" preference.
 *
 * Opening a device is the delay between a press and the first captured sample,
 * so a held-open device is what makes a press feel instant. The cost is the
 * operating system's microphone-in-use indicator, which is why this only
 * happens when the user asked for it, and why the device is released the moment
 * the preference goes off, a recording starts, permission is revoked, or local
 * data is being cleared.
 *
 * This component owns the device. Nothing else calls `warmMicrophone` or
 * `closeMicrophone`, so there is exactly one place that can leave a stream open
 * and one place that can fail to close it.
 */
export const MicrophoneReadinessSideEffects = () => {
  const enabled = useAppStore(
    (state) => state.userPrefs?.keepMicrophoneReady === true,
  );
  const prerollSeconds = useAppStore(
    (state) => state.userPrefs?.microphonePrerollSeconds ?? 0.5,
  );
  const lingerMs = useAppStore(
    (state) => state.userPrefs?.microphoneLingerMs ?? 0,
  );
  const isRecording = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const microphonePermission = useAppStore(
    (state) => state.permissions.microphone ?? null,
  );
  const permissionGranted = isPermissionAuthorized(microphonePermission?.state);

  /**
   * Publishes what the backend says, not what was asked for.
   *
   * The switch reflects the preference; this reflects the device. They differ
   * whenever an open fails, which is the case a user notices as "it says ready
   * but the first word is still late".
   */
  const publishHeld = useCallback(async () => {
    try {
      const held = await commands.microphoneReady();
      if (getAppState().settings.microphoneHeld !== held) {
        produceAppState((draft) => {
          draft.settings.microphoneHeld = held;
        });
      }
    } catch (error) {
      getLogger().warning(`Could not read the microphone state: ${error}`);
    }
  }, []);

  // What this component last told the backend, so a render that does not change
  // the answer costs nothing.
  const appliedRef = useRef<"open" | "closed" | null>(null);

  // The pre-roll the held stream was actually opened with. Changing the slider
  // resizes the ring rather than reopening the device, because reopening would
  // drop the very pre-roll the user is adjusting.
  const openedPrerollRef = useRef<number | null>(null);

  /** Opens or resizes the hold, depending on whether one is already applied. */
  const hold = useCallback(
    (seconds: number) => {
      void commands
        .warmMicrophone(seconds, MICROPHONE_READY_FOREVER_MS)
        .then((result) => {
          void publishHeld();
          if (result.status === "error") {
            // A device that will not open is not a preference failure: the next
            // press opens it the normal way and reports the real problem. The
            // preference stays on, because the user asked for it and it may work
            // once the device comes back.
            getLogger().warning(
              `Could not hold the microphone ready: ${result.error}`,
            );
            // The ring did not take the request, so the next attempt must not
            // believe a stream is held.
            openedPrerollRef.current = null;
            appliedRef.current = null;
          }
        })
        .catch((error: unknown) => {
          getLogger().warning(`Could not hold the microphone ready: ${error}`);
          openedPrerollRef.current = null;
          appliedRef.current = null;
        });
    },
    [publishHeld],
  );

  const release = useCallback(() => {
    openedPrerollRef.current = null;
    void commands
      .closeMicrophone()
      .then(() => {
        void publishHeld();
      })
      .catch((error: unknown) => {
        getLogger().warning(`Could not release the microphone: ${error}`);
        appliedRef.current = null;
        void publishHeld();
      });
  }, [publishHeld]);

  useEffect(() => {
    const shouldHold = shouldHoldMicrophoneReady({
      enabled,
      isRecording,
      isLocalDataClearing: isLocalDataClearRequested(),
      permissionGranted,
    });

    if (!shouldHold) {
      // Anything other than "hold" releases: the preference went off, a
      // recording started, a clear began, or permission was revoked. The last
      // one matters on its own: a revoked permission must not leave a stream the
      // OS no longer authorises running, and the indicator would be a lie.
      if (appliedRef.current === "closed") {
        return;
      }
      appliedRef.current = "closed";
      release();
      return;
    }

    appliedRef.current = "open";

    // The resize path has to be reachable, which is why the "already held" test
    // is on the ring rather than on the open/closed state above: that state only
    // changes when the decision changes, and a slider move does not change it.
    if (openedPrerollRef.current !== null) {
      if (openedPrerollRef.current === prerollSeconds) {
        return;
      }
      openedPrerollRef.current = prerollSeconds;
      hold(prerollSeconds);
      return;
    }

    openedPrerollRef.current = prerollSeconds;
    hold(prerollSeconds);
  }, [enabled, isRecording, permissionGranted, prerollSeconds, hold, release]);

  // The post-recording window is a policy the stop path reads, and it has to be
  // in place before the recording that will stop, not after it. Pushing it on
  // every change also means turning it off takes effect on the next stop rather
  // than on the next launch.
  //
  // It is not pushed while the device is held. Zero means "close at stop", so
  // pushing the preference on mount, before the hold effect has run, closed the
  // very stream the hold opens seconds later. The window is the policy for a
  // device that is not held, so it is set for that case, and the release path
  // restores it when the hold is turned off.
  useEffect(() => {
    if (enabled) {
      return;
    }
    void commands.setMicrophoneLinger(lingerMs).catch((error: unknown) => {
      getLogger().warning(`Could not set the linger window: ${error}`);
    });
  }, [enabled, lingerMs]);

  // One read on mount, so the dialog shows the truth before anything is toggled.
  useEffect(() => {
    void publishHeld();
  }, [publishHeld]);

  // A hold that failed has no state change to retry on: the preference did not
  // change, the device did. Coming back to the window is the moment a user has
  // most likely just plugged something in, so that is when the attempt is made
  // again, and the answer is re-read either way.
  useEffect(() => {
    const retryOnFocus = () => {
      void publishHeld();
      const state = getAppState();
      if (
        state.userPrefs?.keepMicrophoneReady !== true ||
        state.settings.microphoneHeld === true ||
        state.activeRecordingMode !== null ||
        !isPermissionAuthorized(state.permissions.microphone?.state) ||
        isLocalDataClearRequested()
      ) {
        return;
      }
      openedPrerollRef.current =
        state.userPrefs.microphonePrerollSeconds ?? 0.5;
      appliedRef.current = "open";
      hold(openedPrerollRef.current);
    };
    window.addEventListener("focus", retryOnFocus);
    return () => window.removeEventListener("focus", retryOnFocus);
  }, [hold, publishHeld]);

  // The cheap half of readiness: with no stream held, resolve which device the
  // next press would open, so the press skips the enumeration and scoring. It
  // opens nothing, so there is no indicator and no cost worth avoiding.
  useEffect(() => {
    const shouldPrepare = shouldPrepareMicrophone({
      isRecording,
      isLocalDataClearing: isLocalDataClearRequested(),
      permissionGranted,
      holdActive: enabled && !isRecording,
    });
    if (!shouldPrepare) {
      return;
    }
    void commands.prepareMicrophone().catch((error: unknown) => {
      // A device that cannot be resolved now is resolved by the next press.
      getLogger().warning(`Could not prepare the microphone: ${error}`);
    });
  }, [enabled, isRecording, permissionGranted]);

  // A clear is requested outside React state, so subscribe to the transition
  // rather than reading the latch once. Reading it in an effect that depends
  // only on the preference means a clear requested later never closes a device
  // that is already held, which is exactly the case that matters: the clear
  // deletes the audio, and a microphone still running through it is live for
  // nothing.
  useEffect(() => {
    return subscribeToLocalDataClearRequested(() => {
      if (getAppState().userPrefs?.keepMicrophoneReady !== true) {
        return;
      }
      appliedRef.current = "closed";
      release();
    });
  }, [release]);

  return null;
};
