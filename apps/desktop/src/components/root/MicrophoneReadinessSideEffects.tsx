import { useCallback, useEffect, useRef } from "react";
import { commands } from "@maus-inc/desktop-native-apis";
import { emit, listen } from "@tauri-apps/api/event";
import { MICROPHONE_READINESS_EVENT } from "@maus-inc/desktop-utils";
import { refreshCurrentUser } from "../../actions/user-activity.actions";
import { isMainLocalDataWindow } from "../../utils/local-data-write-gate";
import { produceAppState, useAppStore } from "../../store";
import { getAppState } from "../../store";
import { showSnackbar } from "../../actions/app.actions";
import { getIntl } from "../../i18n/intl";
import { getLogger } from "../../utils/log.utils";
import {
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import {
  MICROPHONE_READY_FOREVER_MS,
  classifyMicrophoneFailure,
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
      if (getAppState().settings.microphoneHeld === held) {
        return;
      }
      produceAppState((draft) => {
        draft.settings.microphoneHeld = held;
      });
      // Only the main window broadcasts: several windows each emitting would
      // multiply the traffic, and every listener would then re-read N times.
      if (isMainLocalDataWindow()) {
        void emit(MICROPHONE_READINESS_EVENT, { held }).catch(
          (error: unknown) => {
            getLogger().verbose(
              `Could not broadcast the microphone state: ${error}`,
            );
          },
        );
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

  // Whether the last attempt failed, so a retry that succeeds can clear the
  // message and a repeat failure does not announce itself on every focus.
  const holdFailedRef = useRef<boolean | null>(null);

  // Whether the user has been told that permission is what is blocking the hold.
  const holdRefusedRef = useRef(false);

  /**
   * Tells the user the hold could not be opened, once per failure.
   *
   * Silence was the old behaviour and it is the worst of the options: the switch
   * says on, nothing is held, and the press the setting promised to make instant
   * is slow again for a reason the user cannot see.
   */
  const reportHoldFailure = useCallback((error: unknown) => {
    if (holdFailedRef.current === true) {
      return;
    }
    holdFailedRef.current = true;
    getLogger().warning(`Could not hold the microphone ready: ${error}`);
    // The generic message is the fallback, not the default. Two failures are
    // named because the user can act on them and the generic text would leave
    // them guessing: another application holding the device, and access being
    // blocked. Everything else keeps the generic wording, because guessing at a
    // cause the message does not state is how a user ends up closing
    // applications at random.
    const failure = classifyMicrophoneFailure(error);
    const defaultMessage =
      failure === "in_use_by_another_application"
        ? "Another application is using the microphone. Close it, then try again."
        : failure === "permission_denied"
          ? "Microphone access is blocked. Allow it in your system settings, then try again."
          : "Could not open the microphone in advance. Dictation still works, but the first press will be slower.";
    showSnackbar(
      getIntl().formatMessage({ defaultMessage }),
      // Not an error: dictation still works, it is only slower than the user was
      // promised. Error styling would overstate it.
      { mode: "info" },
    );
  }, []);

  const clearHoldFailure = useCallback(() => {
    holdFailedRef.current = null;
  }, []);

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
            reportHoldFailure(result.error);
            // The ring did not take the request, so the next attempt must not
            // believe a stream is held.
            openedPrerollRef.current = null;
            appliedRef.current = null;
            return;
          }
          clearHoldFailure();
        })
        .catch((error: unknown) => {
          reportHoldFailure(error);
          openedPrerollRef.current = null;
          appliedRef.current = null;
        });
    },
    [clearHoldFailure, publishHeld, reportHoldFailure],
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

  // The preference can be changed in another window, and a window whose copy
  // says "off" would leave its device open after the user turned the feature
  // off in the main window. Re-reading on mount and on focus is the cheapest
  // thing that makes the preference global: the read hits the local database,
  // and the write path is a single row.
  useEffect(() => {
    const reread = () => {
      void refreshCurrentUser().catch((error: unknown) => {
        getLogger().verbose(`Could not re-read preferences: ${error}`);
      });
    };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);

  // A hold that was released while this window was hidden, or a preference
  // changed elsewhere, is only noticed when this window looks. The main window
  // publishes the event; every window re-reads rather than trusting a payload,
  // so one window cannot push another into a state the database does not
  // support.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(MICROPHONE_READINESS_EVENT, () => {
      void publishHeld();
      void refreshCurrentUser().catch(() => undefined);
    })
      .then((cleanup) => {
        // The listener may resolve after the component unmounted, which happens
        // in tests and on a fast route change.
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch((error: unknown) => {
        getLogger().verbose(`Could not watch microphone readiness: ${error}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [publishHeld]);

  // Asking for a hold the OS will refuse is the one failure the user can fix,
  // and it is silent by construction: the hold is never attempted, so nothing
  // reports anything. The message names the fix rather than the symptom.
  useEffect(() => {
    if (!enabled || permissionGranted) {
      holdRefusedRef.current = false;
      return;
    }
    if (holdRefusedRef.current) {
      return;
    }
    holdRefusedRef.current = true;
    showSnackbar(
      getIntl().formatMessage({
        defaultMessage:
          "The microphone is blocked, so it cannot be kept ready. Allow microphone access in your system settings and it will open automatically.",
      }),
      { mode: "info" },
    );
  }, [enabled, permissionGranted]);

  // A hold that failed has no state change to retry on: the preference did not
  // change, the device did. Coming back to the window is the moment a user has
  // most likely just plugged something in, so that is when the attempt is made
  // again, and the answer is re-read either way.
  useEffect(() => {
    const retryOnFocus = () => {
      void publishHeld();
      // Enumerating devices is a real cost and the answer is the same for every
      // window, because the backend shares one device. The main window owns the
      // retry so N windows do not each open a stream in turn.
      if (!isMainLocalDataWindow()) {
        return;
      }
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
