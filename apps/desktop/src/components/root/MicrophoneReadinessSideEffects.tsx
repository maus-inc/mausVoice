import { type RefObject, useCallback, useEffect, useRef } from "react";
import { commands } from "@maus-inc/desktop-native-apis";
import { emit, listen } from "@tauri-apps/api/event";
import { MICROPHONE_READINESS_EVENT } from "@maus-inc/desktop-utils";
import { prepareMicrophone } from "../../actions/native.actions";
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
  decideHoldAction,
  shouldHoldMicrophoneReady,
  shouldPrepareMicrophone,
} from "../../utils/microphone-readiness.utils";
import { isPermissionAuthorized } from "../../utils/permission.utils";
import { getMyPreferredMicrophone } from "../../utils/user.utils";

type AppliedHoldState = "open" | "closed" | null;

function useHoldFailureNotice() {
  const holdFailedRef = useRef(false);
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

  const clearHoldFailure = useCallback(() => {
    holdFailedRef.current = false;
  }, []);

  return { reportHoldFailure, clearHoldFailure };
}

function useMicrophonePermissionNotice(
  enabled: boolean,
  permissionGranted: boolean,
  permissionBlocked: boolean,
) {
  const holdRefusedRef = useRef(false);
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
}

function useMicrophoneReadinessSubscription(publishHeld: () => void) {
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
}

function useMicrophoneFocusRetry(
  hold: (seconds: number, device: string | null) => void,
  readHeld: () => Promise<boolean | null>,
  openedPrerollRef: RefObject<{
    preroll: number;
    device: string | null;
  } | null>,
  appliedRef: RefObject<AppliedHoldState>,
) {
  // Whether a focus retry should reopen the device: the same conditions the hold
  // effect uses, asked of the live store rather than of React state.
  //
  const shouldHoldNow = useCallback((held: boolean) => {
    const state = getAppState();
    return (
      !held &&
      shouldHoldMicrophoneReady({
        enabled: state.userPrefs?.keepMicrophoneReady === true,
        isRecording: state.activeRecordingMode !== null,
        isLocalDataClearing: isLocalDataClearRequested(),
        permissionGranted: isPermissionAuthorized(
          state.permissions.microphone?.state,
        ),
      })
    );
  }, []);

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
    const ownsRetry = (held: boolean | null) =>
      // `null` is a failed read, folded in here so a caller cannot forget it: an
      // answer nobody could obtain is not a hold, and the three callers would
      // otherwise each repeat that check.
      held !== null && isMainLocalDataWindow() && shouldHoldNow(held);

    /**
     * Re-reads the saved preference, returning whether it could be done.
     *
     * The preference is re-read before opening, not trusted from the store.
     * Another window can turn keep-ready off while this one still holds the old
     * value: the broadcast that tells it is a separate round trip, and a focus
     * landing in that gap would reopen a microphone the user just switched off.
     * Nothing downstream would close it again, because this window's own
     * preference is about to become false and the release path only fires on a
     * *change*. Opening is the one step worth a round trip: closing the wrong
     * microphone is cheap to correct, opening one the user turned off is not.
     *
     * A failed re-read returns false rather than falling through: the whole
     * point of the round trip is that this window's copy might be out of date,
     * so "could not tell" must not resolve to "go ahead".
     */
    const rereadPreference = async (): Promise<boolean> => {
      try {
        await refreshCurrentUser();
        return true;
      } catch (error) {
        getLogger().warning(
          `Could not re-read the preference before reopening the microphone: ${error}`,
        );
        return false;
      }
    };

    /**
     * The pre-roll and device this window should hold, read from the store now.
     *
     * Re-read rather than trusted from `ownsRetry`: `shouldHoldNow` is a separate
     * function, so TypeScript cannot carry its narrowing across the call, and the
     * store can be read again without changing the decision it just made.
     *
     * Rebuilt from the store rather than kept from the ring's old value, because
     * that value is what a previous attempt wrote, and this retry exists
     * precisely because that attempt did not leave a stream behind. The two
     * defaults are the recorder's own, so an absent preference holds the device
     * for a usable window rather than failing the retry.
     */
    const readHoldSnapshot = () => {
      const state = getAppState();
      return {
        preroll: state.userPrefs?.microphonePrerollSeconds ?? 0.5,
        device: getMyPreferredMicrophone(state),
      };
    };

    /**
     * Re-establishes the hold, on the answer the backend just gave.
     *
     * `publishHeld` is fire-and-forget, so reading `microphoneHeld` right after
     * it sees the value from *before* that read. That stale value is the whole
     * question for this retry: a stream that died still reports `true`, so
     * `shouldHoldNow` said "a hold is open, nothing to do" and the retry that
     * exists to reopen a dead stream never ran.
     */
    const retryOnFocus = async () => {
      // One question, so one guard: is there a hold that this window owns, on the
      // answer the backend just gave? `null` means the read failed, which is not
      // a hold either.
      const held = await readHeld();
      if (!ownsRetry(held)) {
        return;
      }
      // Asked again on purpose, on what the re-read wrote rather than on what the
      // store held before it: the first decision ran against a preference this
      // window may have had reason to doubt, and only this one is authoritative.
      const refreshed = await rereadPreference();
      if (!refreshed) {
        return;
      }
      if (!ownsRetry(held)) {
        return;
      }
      const snapshot = readHoldSnapshot();
      openedPrerollRef.current = snapshot;
      appliedRef.current = "open";
      hold(snapshot.preroll, snapshot.device);
    };
    const onFocus = () => {
      // The listener itself cannot be async: `addEventListener` ignores the
      // returned promise, so a rejection inside it would be unhandled.
      logOnRejection(retryOnFocus(), "microphone retry on focus");
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hold, readHeld, shouldHoldNow, openedPrerollRef, appliedRef]);
}

function useWarmMicrophoneRequests(
  openedPrerollRef: RefObject<{
    preroll: number;
    device: string | null;
  } | null>,
  appliedRef: RefObject<AppliedHoldState>,
  publishHeld: () => void,
) {
  const { reportHoldFailure, clearHoldFailure } = useHoldFailureNotice();

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

  const pendingPolicyRef = useRef<Promise<void> | null>(null);
  // Queue failures do not block later work; callers await or report their own result.
  const queuePolicyChange = useCallback(<T,>(change: () => T | Promise<T>) => {
    const previous = pendingPolicyRef.current;
    const pending = (async () => {
      if (previous) {
        // The previous caller reports its failure; do not block later changes.
        await previous;
      }
      return change();
    })();
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    pendingPolicyRef.current = tail;
    return pending.finally(() => {
      if (pendingPolicyRef.current === tail) {
        pendingPolicyRef.current = null;
      }
    });
  }, []);

  const restoreFiniteLinger = useCallback(async () => {
    const milliseconds = getAppState().userPrefs?.microphoneLingerMs ?? 0;
    if (!heldRef.current && milliseconds > 0) {
      await commands.setMicrophoneLinger(milliseconds);
    }
  }, []);

  const closeAndRestoreLinger = useCallback(
    () =>
      queuePolicyChange(async () => {
        await commands.closeMicrophone();
        // Retry once, checking live state again so a newer hold or preference wins.
        await restoreFiniteLinger()
          .catch(restoreFiniteLinger)
          .catch((error: unknown) => {
            getLogger().warning(
              `Could not restore the linger window: ${error}`,
            );
          });
      }),
    [queuePolicyChange, restoreFiniteLinger],
  );

  /**
   * Opens or resizes the hold, depending on whether one is already applied.
   *
   * The device is an argument rather than something read from a ref here. Each
   * caller records that same value in `openedPrerollRef`, and the two have to be
   * one snapshot: a ref written during render can be replayed or discarded by
   * React, so the value `hold` opened with could differ from the one the caller
   * recorded -- and then the next focus would compare against a device the
   * stream was never opened on.
   */
  const hold = useCallback(
    (seconds: number, device: string | null) => {
      heldRef.current = true;
      const request = ++requestRef.current;
      const open = queuePolicyChange(() => {
        if (
          requestRef.current !== request ||
          !heldRef.current ||
          isLocalDataClearRequested()
        ) {
          return null;
        }
        return commands.warmMicrophone(
          seconds,
          MICROPHONE_READY_FOREVER_MS,
          device,
        );
      });
      logOnRejection(
        open
          .then((result) => {
            // A queued close or a newer open runs after this native mutation.
            // Do not publish or act on an answer that no longer owns the UI.
            if (!result || requestRef.current !== request) return;
            if (result.status === "error") {
              // A device that will not open is not a preference failure: the next
              // press opens it the normal way and reports the real problem. The
              // preference stays on, because the user asked for it and it may work
              // once the device comes back.
              reportHoldFailure(result.error);
              // Nothing is held, so the next attempt must not believe a stream is,
              // and neither must the *next* stale answer below. `heldRef` was set
              // optimistically when this open was issued; a failure leaves it true
              // and it is only otherwise cleared by a release, so a superseded open
              // succeeding later would read that leftover flag as "a newer hold
              // owns the device" and leave its own indefinite capture behind.
              openedPrerollRef.current = null;
              appliedRef.current = null;
              heldRef.current = false;
              publishHeld();
              return;
            }
            publishHeld();
            clearHoldFailure();
          })
          .catch((error: unknown) => {
            // A rejection from a superseded request says nothing about the
            // current one. The success path already checks this; without the
            // same check here, changing microphones mid-open let the older
            // promise fail and report a failure for a hold the newer request had
            // already opened -- and cleared the ring the newer request owns, so
            // the next effect run reopened a working stream.
            if (requestRef.current !== request) {
              getLogger().verbose(
                `A superseded microphone open failed after this window stopped asking for it: ${error}`,
              );
              return;
            }
            reportHoldFailure(error);
            openedPrerollRef.current = null;
            appliedRef.current = null;
            // Same reason as the error branch above: a rejected open holds
            // nothing, and leaving `heldRef` set makes a later stale answer think
            // a newer hold owns a stream that does not exist.
            heldRef.current = false;
          }),
        "microphone warm open",
      );
    },
    [
      appliedRef,
      clearHoldFailure,
      openedPrerollRef,
      publishHeld,
      queuePolicyChange,
      reportHoldFailure,
    ],
  );

  const release = useCallback(() => {
    openedPrerollRef.current = null;
    heldRef.current = false;
    requestRef.current += 1;
    return closeAndRestoreLinger()
      .then(() => publishHeld())
      .catch((error: unknown) => {
        getLogger().warning(`Could not release the microphone: ${error}`);
        appliedRef.current = null;
        publishHeld();
      });
  }, [appliedRef, closeAndRestoreLinger, openedPrerollRef, publishHeld]);

  return { hold, release, heldRef, queuePolicyChange };
}

function useMicrophoneReadinessStatus() {
  /**
   * Reads the device state, stores it, and returns what the backend said.
   *
   * The return value exists for the callers that have to *decide* on the answer
   * rather than just publish it. `microphoneHeld` is state, so it is only
   * up to date once the store has re-rendered, and a caller that reads it
   * straight after a floating read sees the value from before.
   */
  const readHeld = useCallback(async (): Promise<boolean | null> => {
    try {
      const held = await commands.microphoneReady();
      if (getAppState().settings.microphoneHeld === held) {
        return held;
      }
      produceAppState((draft) => {
        draft.settings.microphoneHeld = held;
      });
      // Only the main window broadcasts: several windows each emitting would
      // multiply the traffic, and every listener would then re-read N times.
      if (isMainLocalDataWindow()) {
        logOnRejection(
          emit(MICROPHONE_READINESS_EVENT, { held }).catch((error: unknown) => {
            getLogger().verbose(
              `Could not broadcast the microphone state: ${error}`,
            );
          }),
          "microphone readiness broadcast",
        );
      }
      return held;
    } catch (error) {
      getLogger().warning(`Could not read the microphone state: ${error}`);
      // `null` is "could not tell", which the retry treats as "do not decide"
      // rather than as "nothing is held".
      return null;
    }
  }, []);

  const publishHeld = useCallback((): void => {
    // Deliberately not awaited: see the doc comment. `logOnRejection` is the
    // repository's wrapper for a promise nobody awaits, and it is a second net
    // rather than the primary one -- `readHeld` catches everything it awaits, so
    // this only fires if the logger itself throws inside that catch.
    logOnRejection(readHeld(), "microphone state read");
  }, [readHeld]);

  return { readHeld, publishHeld };
}

function useIdleMicrophonePreparation({
  enabled,
  isRecording,
  ownsDevice,
  permissionGranted,
  preferredMicrophone,
  prefsLoaded,
}: {
  enabled: boolean;
  isRecording: boolean;
  ownsDevice: boolean;
  permissionGranted: boolean;
  preferredMicrophone: string | null;
  prefsLoaded: boolean;
}) {
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
    if (!ownsDevice || !prefsLoaded || !shouldPrepare) {
      return;
    }
    const reportPreparationFailure = (error: unknown) => {
      // A device that cannot be resolved now is resolved by the next press.
      getLogger().warning(
        `Could not prepare the microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    logOnRejection(
      prepareMicrophone(preferredMicrophone).catch(reportPreparationFailure),
      "microphone preparation",
    );
  }, [
    enabled,
    isRecording,
    ownsDevice,
    permissionGranted,
    preferredMicrophone,
    prefsLoaded,
  ]);
}

function applyHoldDecision(
  decision: ReturnType<typeof decideHoldAction>,
  {
    appliedRef,
    openedPrerollRef,
    heldRef,
    release,
    hold,
    prerollSeconds,
    preferredMicrophone,
  }: {
    appliedRef: RefObject<AppliedHoldState>;
    openedPrerollRef: RefObject<{
      preroll: number;
      device: string | null;
    } | null>;
    heldRef: RefObject<boolean>;
    release: () => Promise<void>;
    hold: (seconds: number, device: string | null) => void;
    prerollSeconds: number;
    preferredMicrophone: string | null;
  },
) {
  if (decision === "hand-off") {
    // The press has the stream, and from here the stop path decides what
    // becomes of it: it may linger for the post-recording window, it may close
    // at stop, or a fatal recording may retire it. None of those is this
    // component's decision, and all of them make what the ring records here
    // untrue. Dropping the record is what lets this effect reopen once the
    // recording ends; keeping it made the ring claim a stream the stop path had
    // already closed, and `keep ready` then stayed on with no device behind it.
    openedPrerollRef.current = null;
    heldRef.current = false;
    return;
  }
  if (decision === "no-opinion" || decision === "keep") {
    return;
  }
  if (decision === "release") {
    // Anything other than "hold" releases: the preference went off, a clear
    // began, or permission was revoked. The last one matters on its own: a
    // revoked permission must not leave a stream the OS no longer authorises
    // running, and the indicator would be a lie.
    appliedRef.current = "closed";
    void release();
    return;
  }
  // Open, or reopen on a changed pre-roll or device. The resize path has to be
  // reachable, which is why the "already held" test is inside `decideHoldAction`
  // rather than on `appliedRef`: that only changes when the decision changes,
  // and a slider move does not change it.
  appliedRef.current = "open";
  // One snapshot for both: the value recorded here is the value handed to
  // `hold`, so a later comparison cannot disagree with what was opened.
  openedPrerollRef.current = {
    preroll: prerollSeconds,
    device: preferredMicrophone,
  };
  hold(prerollSeconds, preferredMicrophone);
}

function useIdleMicrophonePolicy({
  enabled,
  prefsLoaded,
  ownsDevice,
  prerollSeconds,
  lingerMs,
  heldRef,
  queuePolicyChange,
}: {
  enabled: boolean;
  prefsLoaded: boolean;
  ownsDevice: boolean;
  prerollSeconds: number;
  lingerMs: number;
  heldRef: RefObject<boolean>;
  queuePolicyChange: <T>(change: () => T | Promise<T>) => Promise<T>;
}) {
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
    if (!prefsLoaded || !ownsDevice) {
      return;
    }
    logOnRejection(
      queuePolicyChange(() =>
        commands.setMicrophonePreroll(prerollSeconds),
      ).catch((error: unknown) => {
        getLogger().warning(`Could not set the microphone pre-roll: ${error}`);
      }),
      "microphone pre-roll update",
    );
  }, [ownsDevice, prefsLoaded, prerollSeconds, queuePolicyChange]);

  // Releases restore linger themselves; the ref is only an execution-time guard.
  useEffect(() => {
    if (enabled || !prefsLoaded || !ownsDevice) {
      return;
    }
    logOnRejection(
      queuePolicyChange(async () => {
        if (!heldRef.current) {
          await commands.setMicrophoneLinger(lingerMs);
        }
      }).catch((error: unknown) => {
        getLogger().warning(`Could not set the linger window: ${error}`);
      }),
      "linger window update",
    );
  }, [enabled, prefsLoaded, ownsDevice, lingerMs, queuePolicyChange, heldRef]);
}

function useMicrophoneInputs() {
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
  // The device a press will ask for, read here so the hold opens the same one.
  // Passed down to `hold` by each caller rather than stashed in a ref: a ref
  // write during render is the one thing React may replay or throw away.
  const preferredMicrophone = useAppStore(getMyPreferredMicrophone);
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

  return {
    enabled,
    prefsLoaded,
    prerollSeconds,
    lingerMs,
    preferredMicrophone,
    isRecording,
    permissionGranted,
    permissionBlocked,
  };
}

function useReleaseOnDataClear(
  ownsDevice: boolean,
  appliedRef: RefObject<AppliedHoldState>,
  release: () => Promise<void>,
) {
  useEffect(() => {
    if (!ownsDevice) {
      return undefined;
    }
    return subscribeToLocalDataClearRequested(() => {
      // Readiness measures usable audio, not whether an idle stream is open.
      // Native close is safe even if there is no stream to release.
      appliedRef.current = "closed";
      return release();
    });
  }, [appliedRef, release, ownsDevice]);
}

/**
 * Keeps the capture device in step with the "keep microphone ready" preference.
 *
 * Opening a device is the delay between a press and the first captured sample,
 * so a held-open device is what makes a press feel instant. The cost is the
 * operating system's microphone-in-use indicator, which is why this only
 * happens when the user asked for it, and why the device is released the moment
 * the preference goes off, permission is revoked, or local data is being cleared.
 *
 * A recording starting is deliberately *not* on that list. It adopts the held
 * stream: releasing it on the press made every dictation pay the device open that
 * the hold exists to avoid, and the indicator blinked for the whole cycle. What
 * becomes of the stream is the stop path's decision, not the press's.
 *
 * This component owns the device. Nothing else calls `warmMicrophone` or
 * `closeMicrophone`, so there is exactly one place that can leave a stream open
 * and one place that can fail to close it.
 */
export const MicrophoneReadinessSideEffects = () => {
  const {
    enabled,
    prefsLoaded,
    prerollSeconds,
    lingerMs,
    preferredMicrophone,
    isRecording,
    permissionGranted,
    permissionBlocked,
  } = useMicrophoneInputs();

  const { readHeld, publishHeld } = useMicrophoneReadinessStatus();

  // What this component last told the backend, so a render that does not change
  // the answer costs nothing.
  const appliedRef = useRef<AppliedHoldState>(null);

  // What the held stream was actually opened with: its pre-roll and the device
  // it is bound to. Changing the slider resizes the ring rather than reopening
  // the device, because reopening would drop the very pre-roll the user is
  // adjusting. Changing the *device* is different -- a stream cannot follow one
  // -- so that comparison is what forces the reopen.
  const openedPrerollRef = useRef<{
    preroll: number;
    device: string | null;
  } | null>(null);

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

  const { hold, release, heldRef, queuePolicyChange } =
    useWarmMicrophoneRequests(openedPrerollRef, appliedRef, publishHeld);

  useEffect(() => {
    // A running recording adopts the held stream -- that is the entire point of
    // holding one -- and the stop path decides what becomes of it afterwards.
    //
    // Releasing on a press looked equivalent and is not. `closeMicrophone` also
    // zeroes the linger policy the stop path reads, so the stream the press had
    // just adopted was closed at stop and reopened seconds later: every
    // dictation paid the device open that keep-ready exists to avoid, and the
    // microphone indicator blinked for the whole cycle. The press loses nothing
    // by leaving the device alone, because a second stream is never opened while
    // one is held -- that is what `start_recording` adopting it means.
    const decision = decideHoldAction({
      isRecording,
      prefsLoaded,
      ownsDevice,
      shouldHold: shouldHoldMicrophoneReady({
        enabled,
        isRecording,
        isLocalDataClearing: isLocalDataClearRequested(),
        permissionGranted,
      }),
      applied: appliedRef.current,
      held: openedPrerollRef.current,
      prerollSeconds,
      preferredMicrophone,
    });

    applyHoldDecision(decision, {
      appliedRef,
      openedPrerollRef,
      heldRef,
      release,
      hold,
      prerollSeconds,
      preferredMicrophone,
    });
  }, [
    enabled,
    prefsLoaded,
    isRecording,
    permissionGranted,
    prerollSeconds,
    // Re-runs on a microphone change so the hold moves to the device the next
    // press will use, rather than staying on the one the user just left.
    preferredMicrophone,
    ownsDevice,
    hold,
    release,
    heldRef,
  ]);

  useIdleMicrophonePolicy({
    enabled,
    prefsLoaded,
    ownsDevice,
    prerollSeconds,
    lingerMs,
    heldRef,
    queuePolicyChange,
  });

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
  useMicrophoneReadinessSubscription(publishHeld);

  useMicrophonePermissionNotice(enabled, permissionGranted, permissionBlocked);

  useMicrophoneFocusRetry(hold, readHeld, openedPrerollRef, appliedRef);

  useIdleMicrophonePreparation({
    enabled,
    isRecording,
    ownsDevice,
    permissionGranted,
    preferredMicrophone,
    prefsLoaded,
  });

  useReleaseOnDataClear(ownsDevice, appliedRef, release);

  return null;
};
