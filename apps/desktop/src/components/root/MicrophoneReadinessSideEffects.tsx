import { useCallback, useEffect, useRef } from "react";
import { commands } from "@maus-inc/desktop-native-apis";
import { emit, listen } from "@tauri-apps/api/event";
import { MICROPHONE_READINESS_EVENT } from "@maus-inc/desktop-utils";
import { refreshCurrentUser } from "../../actions/user-activity.actions";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { showSnackbar } from "../../actions/app.actions";
import { getIntl } from "../../i18n/intl";
import { getLogger } from "../../utils/log.utils";
import { logOnRejection } from "../../utils/promise.utils";
import {
  isLocalDataClearRequested,
  isMainLocalDataWindow,
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
  // Three states, because `null` is not "off".
  //
  // The preferences arrive asynchronously, so every window mounts this component
  // with `userPrefs === null` for the first frames. Collapsing that into `false`
  // made the null frame indistinguishable from the user having turned the
  // preference off, and the release effect below duly closed the shared device
  // -- which another window had opened -- before any preference had been read.
  // `null` means "not loaded yet": hold nothing, close nothing, decide nothing.
  const keepReadySetting = useAppStore(
    (state) => state.userPrefs?.keepMicrophoneReady ?? null,
  );
  const prefsLoaded = keepReadySetting !== null;
  const enabled = keepReadySetting === true;
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
   * The OS has actually said no, as opposed to not having answered yet.
   *
   * `permissions.microphone` is `null` until the first check completes, and it
   * returns to `null` when a check fails. Treating either as a refusal told the
   * user their microphone was blocked on the strength of a value that had not
   * arrived, which is a claim this component cannot make. Nothing is attempted
   * in both cases, so the hold still waits; only the message differs.
   */
  const permissionBlocked = microphonePermission !== null && !permissionGranted;

  /**
   * Publishes what the backend says, not what was asked for.
   *
   * The switch reflects the preference; this reflects the device. They differ
   * whenever an open fails, which is the case a user notices as "it says ready
   * but the first word is still late".
   *
   * Returns `void` rather than a promise, and that is load-bearing. Every one of
   * the nine call sites below wants the read and nothing else: none of them
   * awaits it, and none can act on a rejection. A function that returns
   * `Promise<void>` and is never awaited forces each caller to write `void` to
   * say "I know this is a floating promise", which is a marker with no effect on
   * what happens at runtime. Absorbing the promise here instead means the
   * callers are synchronous calls that genuinely have nothing to wait for, and
   * the rejection handling lives at the one place that owns it.
   *
   * The rejection cannot escape either way: `commands.microphoneReady()` is
   * awaited inside the `try`, and the broadcast promise is caught. The change is
   * to the type, so a future caller cannot accidentally depend on the timing of
   * a read that is deliberately fire-and-forget.
   */
  const publishHeld = useCallback((): void => {
    const read = async () => {
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
          logOnRejection(
            emit(MICROPHONE_READINESS_EVENT, { held }).catch(
              (error: unknown) => {
                getLogger().verbose(
                  `Could not broadcast the microphone state: ${error}`,
                );
              },
            ),
            "microphone readiness broadcast",
          );
        }
      } catch (error) {
        getLogger().warning(`Could not read the microphone state: ${error}`);
      }
    };
    // Deliberately not awaited: see the doc comment. `logOnRejection` is the
    // repository's wrapper for a promise nobody awaits, and it is a second net
    // rather than the primary one -- `read` catches everything it awaits, so
    // this only fires if the logger itself throws inside that catch.
    logOnRejection(read(), "microphone state read");
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
   * Whether this window believes a hold is open, or opening.
   *
   * `appliedRef` cannot answer this: it is nulled on every failure path and it
   * records what the effect *decided*, not what the backend was asked for. This
   * one is written at the two places that actually open (the hold effect and the
   * focus retry) and read by the release continuation below, where the question
   * is narrower: has something opened a stream since I zeroed the policy?
   */
  const heldRef = useRef(false);

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
    // Each message is its own literal at its own `formatMessage` call, rather
    // than one literal chosen into a variable and formatted once. The extractor
    // only sees `defaultMessage` when it is a string literal at the call site:
    // with the variable form, two of these three were absent from the catalogue
    // while the app still asked for them, so they rendered as their ids until
    // the next extraction pruned them.
    const intl = getIntl();
    // A function per cause rather than a chain of ternaries: a nested ternary
    // is read right-to-left and the two actionable causes were the hardest part
    // of this block to follow. Each arm still keeps its literal at its own
    // `formatMessage` call for the reason above.
    const messageFor = (cause: typeof failure): string => {
      if (cause === "in_use_by_another_application") {
        return intl.formatMessage({
          defaultMessage:
            "Another application is using the microphone. Close it, then try again.",
        });
      }
      if (cause === "permission_denied") {
        return intl.formatMessage({
          defaultMessage:
            "Microphone access is blocked. Allow it in your system settings, then try again.",
        });
      }
      return intl.formatMessage({
        defaultMessage:
          "Could not open the microphone in advance. Dictation still works, but the first press will be slower.",
      });
    };
    const message = messageFor(failure);
    showSnackbar(
      message,
      // Not an error: dictation still works, it is only slower than the user was
      // promised. Error styling would overstate it.
      { mode: "info" },
    );
  }, []);

  /**
   * Which request this window last made, so a late answer cannot be mistaken
   * for the current one.
   *
   * `warmMicrophone` is an async command that opens a real device and can take
   * seconds. Turning the preference off while it is in flight used to leave the
   * open to finish afterwards, promote itself to a hold, and leave a microphone
   * running with nothing in the UI asking for it. Each request and each release
   * takes a number here; a reply whose number is not the latest is stale, and a
   * stale open is closed again rather than adopted.
   */
  const requestRef = useRef(0);

  /**
   * The stored post-recording window, readable from a callback.
   *
   * `release` is created once and must not carry a stale closure over the
   * preference, so the value lives in a ref that every render keeps current. It
   * is read when a release completes, to put back the policy `closeMicrophone`
   * zeroed on its way out.
   */
  const lingerRef = useRef(0);
  lingerRef.current = lingerMs;

  /**
   * Whether this window is the one that owns the held device.
   *
   * There is one device and one backend for the whole process, but a floating
   * window mounts this same component: {@link Root} renders it wherever a
   * recording can be started. Left ungated, a floating window that mounts while
   * the preference is off would release the stream the main window is holding,
   * and the same happens again when it unmounts or when a re-render changes the
   * decision. Only the main window holds or releases anything; every other
   * window reads the result back through `microphoneReady`, which is what the
   * switch and the dialog display.
   */
  const ownsDevice = isMainLocalDataWindow();

  const clearHoldFailure = useCallback(() => {
    holdFailedRef.current = null;
  }, []);

  /** Opens or resizes the hold, depending on whether one is already applied. */
  const hold = useCallback(
    (seconds: number) => {
      heldRef.current = true;
      const request = ++requestRef.current;
      logOnRejection(
        commands
          .warmMicrophone(seconds, MICROPHONE_READY_FOREVER_MS)
          .then((result) => {
            if (requestRef.current !== request) {
              // The answer arrived for a request this window has already
              // superseded. The common case is the preference being turned off
              // while the device was opening: `close_microphone` ran first and
              // found nothing, because the stream did not exist yet, and this open
              // then created one that nothing would close. Closing it here is what
              // makes a late answer harmless rather than a leaked microphone.
              getLogger().info(
                "a microphone open finished after this window stopped asking for it; closing it",
              );
              //
              // This chain used to have no failure path at all, unlike every other
              // close in this file. A `closeMicrophone` that rejects left the read
              // below unrun, so the dialog went on displaying "held" for a stream
              // this component had just given up on, and the rejection surfaced as
              // an unhandled one. The close is still attempted and the state is
              // still re-read, because a close that failed leaves the stream open
              // and that is exactly the state the user needs to be shown.
              logOnRejection(
                commands.closeMicrophone().then(
                  () => publishHeld(),
                  (error: unknown) => {
                    getLogger().warning(
                      `Could not close the microphone opened after this window stopped asking for it: ${error}`,
                    );
                    publishHeld();
                  },
                ),
                "close of a superseded microphone open",
              );
              return;
            }
            publishHeld();
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
          }),
        "microphone warm open",
      );
    },
    [clearHoldFailure, publishHeld, reportHoldFailure],
  );

  /**
   * Puts the post-recording window back after a release zeroed it.
   *
   * Read from a ref rather than a closure because `release` is created once and
   * must not carry a staleness-prone copy of the preference.
   */
  const restoreLinger = useCallback((milliseconds: number) => {
    logOnRejection(
      commands.setMicrophoneLinger(milliseconds).catch((error: unknown) => {
        getLogger().warning(`Could not restore the linger window: ${error}`);
      }),
      "linger restore after release",
    );
  }, []);

  const release = useCallback(() => {
    openedPrerollRef.current = null;
    heldRef.current = false;
    // Invalidates every open still in flight: any answer from one of them is for
    // a hold this window no longer wants, and `hold` closes it on arrival.
    requestRef.current += 1;
    // `release_hold` zeroes the linger policy on its way out, and the
    // post-recording window is a *separate* preference: closing the hold used to
    // turn it off silently, so every later recording stopped and closed the
    // device instead of leaving it open for the next press. Restoring it here is
    // what makes that harmless. Not while something has opened since: the close
    // and the hold are separately issued commands, so their continuations can
    // interleave, and a restore landing after a new hold would overwrite the
    // sentinel `warm_microphone` opened it with, closing the hold on a timer.
    // Skipping the restore must not skip the read, because the dialog learns
    // what the device is doing from that read.
    logOnRejection(
      commands
        .closeMicrophone()
        .then(() => {
          if (!heldRef.current && lingerRef.current > 0) {
            restoreLinger(lingerRef.current);
          }
          publishHeld();
        })
        .catch((error: unknown) => {
          getLogger().warning(`Could not release the microphone: ${error}`);
          appliedRef.current = null;
          publishHeld();
        }),
      "microphone release",
    );
  }, [publishHeld, restoreLinger]);

  useEffect(() => {
    // A running recording adopts the held stream -- that is the entire point of
    // holding one -- and the stop path decides what becomes of it afterwards.
    // So a recording is the one situation where this component must do nothing
    // at all, which is different from the situations below where it must let go.
    //
    // Releasing here looked equivalent and is not. `closeMicrophone` also zeroes
    // the linger policy the stop path reads, so the stream the press had just
    // adopted was closed at stop and reopened seconds later: every dictation paid
    // the device open that keep-ready exists to avoid, and the microphone
    // indicator blinked for the whole cycle. The press loses nothing by leaving
    // the device alone, because a second stream is never opened while one is held
    // -- that is what `start_recording` adopting it means.
    if (isRecording) {
      return;
    }

    // Also returns before deciding anything while the preferences are still
    // loading. Without this the first effect run released a device on the
    // strength of a value that had not arrived.
    if (!prefsLoaded) {
      return;
    }

    // Not "do not hold" but "do not decide": a window that does not own the
    // device must neither open nor close one. Folding this into `shouldHold`
    // below would route it to the release branch, which is the opposite of what
    // a floating window should do with the main window's stream.
    if (!ownsDevice) {
      return;
    }

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
  }, [
    enabled,
    prefsLoaded,
    isRecording,
    permissionGranted,
    prerollSeconds,
    ownsDevice,
    hold,
    release,
  ]);

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
  // The pre-roll applies to both paths, so it is not gated on keep-ready.
  //
  // The open path takes it as an argument, which covers a held stream. With
  // keep-ready off nothing opens until the press, so without this the recorder
  // used its own 500 ms default and the slider had no effect on a cold start --
  // the case pre-roll exists for, since a cold start is when the first word is
  // most likely to be clipped.
  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    logOnRejection(
      commands.setMicrophonePreroll(prerollSeconds).catch((error: unknown) => {
        getLogger().warning(`Could not set the microphone pre-roll: ${error}`);
      }),
      "microphone pre-roll update",
    );
  }, [prefsLoaded, prerollSeconds]);

  useEffect(() => {
    if (enabled || !prefsLoaded) {
      return;
    }
    logOnRejection(
      commands.setMicrophoneLinger(lingerMs).catch((error: unknown) => {
        getLogger().warning(`Could not set the linger window: ${error}`);
      }),
      "linger window update",
    );
  }, [enabled, prefsLoaded, lingerMs]);

  // One read on mount, so the dialog shows the truth before anything is toggled.
  useEffect(() => {
    publishHeld();
  }, [publishHeld]);

  // The preference can be changed in another window, and a window whose copy
  // says "off" would leave its device open after the user turned the feature
  // off in the main window. Re-reading on mount and on focus is the cheapest
  // thing that makes the preference global: the read hits the local database,
  // and the write path is a single row.
  useEffect(() => {
    const reread = () => {
      logOnRejection(
        refreshCurrentUser().catch((error: unknown) => {
          getLogger().verbose(`Could not re-read preferences: ${error}`);
        }),
        "preference re-read on focus",
      );
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
    logOnRejection(
      listen(MICROPHONE_READINESS_EVENT, () => {
        publishHeld();
        logOnRejection(
          refreshCurrentUser().catch(() => undefined),
          "preference re-read on readiness event",
        );
      })
        .then((cleanup) => {
          // The listener may resolve after the component unmounted, which
          // happens in tests and on a fast route change.
          if (disposed) {
            cleanup();
            return;
          }
          unlisten = cleanup;
        })
        .catch((error: unknown) => {
          getLogger().verbose(`Could not watch microphone readiness: ${error}`);
        }),
      "microphone readiness subscription",
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [publishHeld]);

  // Asking for a hold the OS will refuse is the one failure the user can fix,
  // and it is silent by construction: the hold is never attempted, so nothing
  // reports anything. The message names the fix rather than the symptom.
  useEffect(() => {
    if (!enabled || permissionGranted || !permissionBlocked) {
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
    // `permissionBlocked` as well as `permissionGranted`: the state goes from
    // `null` (unknown) to `denied` (refused) with `permissionGranted` false on
    // both sides, so this effect would not re-run and the user would never be
    // told about a refusal the app does know about.
  }, [enabled, permissionGranted, permissionBlocked]);

  // Whether a focus retry should reopen the device: the same conditions the hold
  // effect uses, asked of the live store rather than of React state.
  //
  // Five conditions, each named.
  //
  // The inline version was one five-term `&&` expression inside a callback that
  // runs on every window focus. It scored 8 on cyclomatic complexity and, worse,
  // read as a single long negation: the two terms in the middle were the ones
  // that mattered and they were the hardest to find. Naming them costs nothing
  // at run time and makes the decision legible. The terms themselves are
  // unchanged.
  //
  // Each predicate takes the state it reads rather than closing over a copy, so
  // the set is readable in one place and a caller cannot accidentally read a
  // stale snapshot between two of them.
  const holdsNothingYet = useCallback(() => {
    const state = getAppState();
    // `!== true` rather than `!`: `microphoneHeld` is `null` before the first
    // read comes back, and null is not "not held", it is "not known yet".
    return state.settings.microphoneHeld !== true;
  }, []);

  const isIdle = useCallback(
    () => getAppState().activeRecordingMode === null,
    [],
  );

  const mayUseMicrophone = useCallback(
    () => isPermissionAuthorized(getAppState().permissions.microphone?.state),
    [],
  );

  const dataIsIntact = useCallback(() => !isLocalDataClearRequested(), []);

  const shouldHoldNow = useCallback(() => {
    return (
      getAppState().userPrefs?.keepMicrophoneReady === true &&
      holdsNothingYet() &&
      isIdle() &&
      mayUseMicrophone() &&
      dataIsIntact()
    );
  }, [holdsNothingYet, isIdle, mayUseMicrophone, dataIsIntact]);

  // A hold that failed has no state change to retry on: the preference did not
  // change, the device did. Coming back to the window is the moment a user has
  // most likely just plugged something in, so that is when the attempt is made
  // again, and the answer is re-read either way.
  useEffect(() => {
    /**
     * Whether this window is the one that retries.
     *
     * Two questions, asked once: only the main window may open a stream, because
     * the backend shares one device and N windows would each open in turn; and
     * only a window whose preferences still say "hold" has anything to retry.
     * Named because the focus handler otherwise read as a run of early returns
     * whose reasons lived in comments rather than in the conditions.
     */
    const ownsRetry = () => isMainLocalDataWindow() && shouldHoldNow();

    const retryOnFocus = () => {
      publishHeld();
      if (!ownsRetry()) {
        return;
      }
      // Re-read rather than trust `ownsRetry`: `shouldHoldNow` is a separate
      // function, so TypeScript cannot carry its narrowing across the call, and
      // the store can be read again without changing the decision it just made.
      const state = getAppState();
      openedPrerollRef.current =
        state.userPrefs?.microphonePrerollSeconds ?? 0.5;
      appliedRef.current = "open";
      hold(openedPrerollRef.current);
    };
    window.addEventListener("focus", retryOnFocus);
    return () => window.removeEventListener("focus", retryOnFocus);
  }, [hold, publishHeld, shouldHoldNow]);

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
    logOnRejection(
      commands.prepareMicrophone().catch((error: unknown) => {
        // A device that cannot be resolved now is resolved by the next press.
        getLogger().warning(`Could not prepare the microphone: ${error}`);
      }),
      "microphone preparation",
    );
  }, [enabled, isRecording, permissionGranted]);

  // A clear is requested outside React state, so subscribe to the transition
  // rather than reading the latch once. Reading it in an effect that depends
  // only on the preference means a clear requested later never closes a device
  // that is already held, which is exactly the case that matters: the clear
  // deletes the audio, and a microphone still running through it is live for
  // nothing.
  useEffect(() => {
    return subscribeToLocalDataClearRequested(() => {
      // The preference is *not* the right question. A stream can be open with
      // keep-ready off, because the post-dictation linger window leaves one open
      // for its duration, and that stream is capturing through the deletion just
      // as much as a held one. Asking the preference skipped exactly that case:
      // the audio is being deleted and the microphone is still running.
      //
      // So the question is whether there is anything to release, which only the
      // backend can answer -- `microphoneHeld` is its report, not a guess.
      const anythingOpen =
        getAppState().userPrefs?.keepMicrophoneReady === true ||
        getAppState().settings.microphoneHeld === true;
      // A window that does not own the device must not close one: the stream is
      // shared, so a floating window reacting to the same broadcast would release
      // the main window's hold on a clear it did not start.
      if (!anythingOpen || !ownsDevice) {
        return;
      }
      appliedRef.current = "closed";
      release();
    });
  }, [release, ownsDevice]);

  return null;
};
