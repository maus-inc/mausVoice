import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "@maus-inc/desktop-native-apis";
import { Member, Nullable, Term, User } from "@maus-inc/types";
import { getRec, listify } from "@maus-inc/utilities";
import { isEqual } from "lodash-es";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { combineLatest, from, Observable, of } from "rxjs";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  canRunPostElevationInit,
  runStartupElevationPreflight,
} from "../../actions/elevation.actions";
import { loadPairedRemoteDevices } from "../../actions/paired-remote-device.actions";
import {
  refreshRemoteReceiverStatus,
  startRemoteReceiver,
} from "../../actions/remote-receiver.actions";
import { handleRemoteFinalTextReceived } from "../../actions/remote-transcript.actions";
import {
  checkForAppUpdates,
  installAvailableUpdate,
} from "../../actions/updater.actions";
import {
  refreshCurrentUser,
  setActiveDictationLanguage,
  setDictationPillVisibility,
  setRemoteOutputEnabled,
  setRemoteTargetDeviceId,
} from "../../actions/user.actions";
import { useAsyncData, useAsyncEffect } from "../../hooks/async.hooks";
import { useElevationStartupReady } from "../../hooks/elevation.hooks";
import { useIntervalAsync, useKeyDownHandler } from "../../hooks/helper.hooks";
import { useHotkeyFire } from "../../hooks/hotkey.hooks";
import { useStreamWithSideEffects } from "../../hooks/stream.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { detectLocale } from "../../i18n";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  getAuthRepo,
  getMemberRepo,
  getTermRepo,
  getTranscriptionRepo,
  getUserRepo,
} from "../../repos";
import {
  AppState,
  HotkeyStrategy,
  KeyboardListenerHealth,
  PasteKeybindSupport,
} from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AuthUser } from "../../types/auth.types";
import { OverlayPhase } from "../../types/overlay.types";
import {
  buildAnalyticsIdentity,
  buildFirstTouchProperties,
  buildPeopleProperties,
  buildSuperProperties,
  getMixpanel,
} from "../../utils/analytics.utils";
import { registerMembers, registerUsers } from "../../utils/app.utils";
import { setPillGeometry } from "../../utils/composer.utils";
import { browserRouter } from "../../router";
import { getIsDevMode } from "../../utils/env.utils";
import { createId } from "../../utils/id.utils";
import {
  ADD_TO_DICTIONARY_HOTKEY,
  getStyleSwitchActionNamesForKey,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { getLogger, initLogging } from "../../utils/log.utils";
import { sendPillFlashMessage } from "../../utils/overlay.utils";
import { isPermissionAuthorized } from "../../utils/permission.utils";
import { getPlatform } from "../../utils/platform.utils";
import { hoursToMilliseconds } from "../../utils/time.utils";
import { getLocalizedDashboardMenuLabels } from "../../utils/tray-dashboard-visibility.utils";
import { buildTrayLanguageMenuModel } from "../../utils/tray-language.utils";
import {
  getLocalizedPillMenuLabel,
  getNextPillVisibility,
  getPillMenuLabel,
} from "../../utils/tray-pill-visibility.utils";
import {
  evaluateHotkeyTrigger,
  releaseHotkey,
} from "../../utils/hotkey-filter.utils";
import {
  getEffectivePillVisibility,
  getIsDictationUnlocked,
  getMyUser,
  getMyUserPreferences,
  LOCAL_USER_ID,
} from "../../utils/user.utils";
import {
  consumeSurfaceWindowFlag,
  surfaceMainWindow,
} from "../../utils/window.utils";

type StreamRet = Nullable<[Nullable<Member>, Nullable<User>]>;

type KeysHeldPayload = {
  keys: string[];
};

type KeyboardListenerHealthPayload = {
  state: KeyboardListenerHealth;
};

type OverlayPhasePayload = {
  phase: OverlayPhase;
};

type RecordingLevelPayload = {
  levels?: number[];
};

type BridgeHotkeyTriggerPayload = {
  hotkey: string;
};

type RemoteFinalTextReceivedPayload = {
  senderDeviceId: string;
  eventId: string;
  text: string;
  mode: string;
  createdAt: string;
};

// Timeout for Firebase Auth initialization.
const AUTH_READY_TIMEOUT_MS = 4_000;

// Cadence of the background update poll.
const UPDATE_CHECK_INTERVAL_MS = hoursToMilliseconds(6);

/**
 * Fingerprint of every state input that decides which combos the native
 * listener grabs (the combo maps themselves plus everything `isActionGrabbable`
 * reads). Those inputs load in an arbitrary order — hotkeys repo, onboarding /
 * user record, strategy probe — so a sync keyed to only one or two of them can
 * leave the listener running on an empty or stale combo set, which is exactly
 * how the global hotkey "stops working" after startup.
 */
const hotkeyGrabFingerprint = (state: AppState): string => {
  const hotkeyKey = Object.values(state.hotkeyById)
    .map((hotkey) => `${hotkey.actionName}:${hotkey.keys.join("+")}`)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  return [
    state.hotkeyStrategy ?? "",
    state.activeRecordingMode ?? "",
    getIsDictationUnlocked(state) ? "1" : "0",
    getEffectiveStylingMode(state),
    hotkeyKey,
  ].join("|");
};

export const AppSideEffects = () => {
  const intl = useIntl();
  // The composer popout is a separate webview that loads the same SPA. The
  // main window is the only surface that owns dictation input, so it is the
  // only window that should track held keys for the dictation pipeline.
  const isMainWindow = getCurrentWindow().label === "main";
  const [authReady, setAuthReady] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [initReady, setInitReady] = useState(false);
  const authReadyRef = useRef(false);
  const startupElevationAttemptedRef = useRef(false);
  // Tracks whether we've already notified about the current listener-failure episode, so the
  // 30s Rust slow-retry churn (failed -> connected -> failed) doesn't re-toast every cycle.
  const listenerFailureNotifiedRef = useRef(false);
  const versionData = useAsyncData(getVersion, []);
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const initialized = useAppStore((state) => state.initialized);
  const member = useAppStore((state) => {
    const uid = state.auth?.uid;
    return uid ? (state.memberById[uid] ?? null) : null;
  });
  const localUser = useAppStore(
    (state) => state.userById[LOCAL_USER_ID] ?? null,
  );
  const prefs = useAppStore((state) => getMyUserPreferences(state));
  const playInteractionChime = useAppStore(
    (state) => getMyUser(state)?.playInteractionChime ?? true,
  );
  const interactionFeedbackVolume = useAppStore(
    (state) => getMyUser(state)?.interactionFeedbackVolume ?? 0.35,
  );
  const keyPermAuthorized = useAppStore((state) =>
    isPermissionAuthorized(getRec(state.permissions, "accessibility")?.state),
  );

  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);

  useAsyncEffect(async () => {
    const [strategy, appDetection, pasteKeybinds] = await Promise.all([
      invoke<HotkeyStrategy>("get_hotkey_strategy"),
      invoke<boolean>("supports_app_detection"),
      invoke<PasteKeybindSupport>("supports_paste_keybinds"),
    ]);
    produceAppState((draft) => {
      draft.hotkeyStrategy = strategy;
      draft.supportsAppDetection = appDetection;
      draft.supportsPasteKeybinds = pasteKeybinds;
    });
  }, []);

  useAsyncEffect(async () => {
    if (hotkeyStrategy !== "listener") {
      return;
    }
    // Only the main window owns the global key grab.
    if (!isMainWindow) {
      return;
    }

    if (keyPermAuthorized) {
      getLogger().info(
        "Accessibility permission authorized, starting key listener",
      );
      await invoke("start_key_listener");
    } else {
      getLogger().info(
        "Accessibility permission not authorized, stopping key listener",
      );
      await invoke("stop_key_listener");
    }

    // Seed health from the current value: transition events emitted before the
    // `keyboard_listener_health` subscription was registered would otherwise be missed,
    // leaving the store stuck at its initial "stopped".
    try {
      const health = await invoke<KeyboardListenerHealth>(
        "get_key_listener_health",
      );
      produceAppState((draft) => {
        draft.keyboardListenerHealth = health;
      });
    } catch (error) {
      getLogger().warning(`Failed to read keyboard listener health: ${error}`);
    }
  }, [keyPermAuthorized, hotkeyStrategy]);

  // Keep the native grab set in lockstep with the state it derives from. The
  // push is gated on the strategy being known so the compositor (bridge) branch
  // of the sync never runs half-configured, and re-runs whenever any
  // grab-relevant input changes — regardless of data load order.
  useEffect(() => {
    // Native hotkey grab sync is owned by the main window only.
    if (!isMainWindow) {
      return;
    }
    const push = () => {
      if (getAppState().hotkeyStrategy) {
        // syncHotkeyCombosToNative rejects if the native grab fails to install
        // (e.g. bridge not ready); swallow it so it doesn't become an unhandled
        // promise rejection that crashes the effect's subscription.
        syncHotkeyCombosToNative().catch((err) => {
          console.warn("[AppSideEffects] hotkey sync failed", err);
        });
      }
    };

    push();

    let lastFingerprint = hotkeyGrabFingerprint(getAppState());
    return useAppStore.subscribe((state) => {
      const next = hotkeyGrabFingerprint(state);
      if (next === lastFingerprint) {
        return;
      }
      lastFingerprint = next;
      push();
    });
  }, []);

  useEffect(() => {
    void initLogging();
  }, []);

  // A23: Keep the native thock gate in sync with the persisted
  // playInteractionChime preference (initial value + changes).
  useEffect(() => {
    invoke("set_interaction_chime_enabled", {
      enabled: playInteractionChime,
    }).catch(() => {});
  }, [playInteractionChime]);

  // Mirror the user-chosen thock gain into Rust so the warm path AND the
  // fallback path apply the live volume. The Rust side clamps to its safe
  // window, so a value outside [0, 1] here is a no-op.
  useEffect(() => {
    invoke("set_interaction_feedback_volume", {
      volume: interactionFeedbackVolume,
    }).catch(() => {});
  }, [interactionFeedbackVolume]);

  // Windows "Always run as administrator" pre-flight. Must stay ahead of
  // auth / Mixpanel / dashboard init — the gate in elevation.actions owns
  // the state transitions so AppSideEffects and the decline dialog cannot
  // diverge. Relaunch is never invoked from Tauri setup().
  useAsyncEffect(async () => {
    if (startupElevationAttemptedRef.current) {
      return;
    }
    startupElevationAttemptedRef.current = true;
    await runStartupElevationPreflight({
      isMainWindow,
      platform: getPlatform(),
    });
  }, []);

  useAsyncEffect(async () => {
    if (consumeSurfaceWindowFlag()) {
      await surfaceMainWindow();
    }
  }, []);

  const onAuthStateChanged = (user: AuthUser | null) => {
    getLogger().info(`Auth state changed (uid=${user?.uid ?? "none"})`);
    authReadyRef.current = true;
    setAuthReady(true);
    produceAppState((draft) => {
      draft.auth = user;
      draft.initialized = false;
    });
  };

  const elevationReady = useElevationStartupReady();

  useTauriListen<OverlayPhasePayload>("overlay_phase", (payload) => {
    produceAppState((draft) => {
      draft.overlayPhase = payload.phase;
      if (payload.phase !== "recording") {
        draft.audioLevels = [];
      }
    });
  });

  useTauriListen<RecordingLevelPayload>("recording_level", (payload) => {
    const raw = Array.isArray(payload.levels) ? payload.levels : [];
    const sanitized = raw.map((value) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0,
    );

    produceAppState((draft) => {
      draft.audioLevels = sanitized;
    });
  });

  useTauriListen<BridgeHotkeyTriggerPayload>(
    "bridge_hotkey_trigger",
    (payload) => {
      // A21: Filter hotkey spam while the pill is in an active recording state.
      // Repeated identical triggers are debounced; stop/cancel always pass.
      // This must happen BEFORE the counter increment so consumers never see
      // a filtered trigger.
      const isRecording = getAppState().overlayPhase === "recording";
      const { allowed, reason } = evaluateHotkeyTrigger(
        payload.hotkey,
        isRecording,
      );
      if (!allowed) {
        getLogger().verbose(
          `[hotkey-filter] blocked ${payload.hotkey}: ${reason}`,
        );
        return;
      }
      produceAppState((draft) => {
        draft.hotkeyTriggers[payload.hotkey] =
          (draft.hotkeyTriggers[payload.hotkey] ?? 0) + 1;
      });
    },
  );

  useTauriListen<KeysHeldPayload>("keys_held", (payload) => {
    // Only the main window owns dictation input; ignore held-key updates in
    // the composer popout (and any other webview) so its SPA copy can't drive
    // a duplicate dictation/style-switch pipeline.
    if (!isMainWindow) {
      return;
    }
    const existing = getAppState().keysHeld;
    if (isEqual(existing, payload.keys)) {
      return;
    }

    // A21: Release a style-switch action's "held" state when its physical key
    // is released. Releasing only when ALL keys are up would never fire during
    // hold-to-talk dictation (the dictate key stays held), wedging style
    // switching after the first press.
    const releasedKeys = existing.filter(
      (key) =>
        !payload.keys.some((held) => held.toLowerCase() === key.toLowerCase()),
    );
    if (releasedKeys.length > 0) {
      for (const key of releasedKeys) {
        for (const actionName of getStyleSwitchActionNamesForKey(
          getAppState(),
          key,
        )) {
          releaseHotkey(actionName);
        }
      }
    }

    produceAppState((draft) => {
      draft.keysHeld = payload.keys;
    });
  });

  // Surface listener health (grounded in the child's actual grab/listen outcome). Rust owns
  // automatic recovery; TS only reflects state here and exposes a manual retry elsewhere — it
  // must not auto-restart the listener on "failed".
  useTauriListen<KeyboardListenerHealthPayload>(
    "keyboard_listener_health",
    (payload) => {
      if (getAppState().keyboardListenerHealth === payload.state) {
        return;
      }
      // Reset the failure notification once the listener genuinely recovers, so a later
      // failure episode can notify again.
      if (
        payload.state === "healthy_grab" ||
        payload.state === "degraded_listen_fallback"
      ) {
        listenerFailureNotifiedRef.current = false;
      }
      if (payload.state === "failed" && !listenerFailureNotifiedRef.current) {
        listenerFailureNotifiedRef.current = true;
        getLogger().warning("Keyboard listener reported failed health");
        const authorized = isPermissionAuthorized(
          getRec(getAppState().permissions, "accessibility")?.state,
        );
        if (authorized) {
          showSnackbar(
            intl.formatMessage({
              defaultMessage:
                "Keyboard hotkeys stopped working. Retrying automatically; restart mausVoice if this persists.",
            }),
            { mode: "error", duration: 6000 },
          );
        }
      }
      produceAppState((draft) => {
        draft.keyboardListenerHealth = payload.state;
      });
    },
  );

  useTauriListen<RemoteFinalTextReceivedPayload>(
    "remote_final_text_received",
    async (payload) => {
      // Inserting the remote transcript is a window-global action; only the
      // main window must perform it to avoid double-insertion from a popout.
      if (!isMainWindow) {
        return;
      }
      await handleRemoteFinalTextReceived(payload);
      await refreshRemoteReceiverStatus().catch(() => undefined);
    },
  );

  // Auth and the rest of full-app init stay behind the elevation gate so a
  // declined-or-pending UAC never pays for Firebase / Mixpanel / remote
  // receiver setup on the unelevated helper surface.
  useEffect(() => {
    if (!canRunPostElevationInit(elevationReady)) {
      return;
    }

    authReadyRef.current = false;

    const timeoutId = setTimeout(() => {
      if (!authReadyRef.current) {
        getLogger().warning("Auth timed out, proceeding without auth");
        onAuthStateChanged(null);
      }
    }, AUTH_READY_TIMEOUT_MS);

    const unsubscribe = getAuthRepo().onAuthStateChanged(
      onAuthStateChanged,
      (error) => {
        showErrorSnackbar(error);
        onAuthStateChanged(null);
      },
    );

    return () => {
      clearTimeout(timeoutId);
      unsubscribe();
    };
  }, [elevationReady]);

  useStreamWithSideEffects({
    builder: (): Observable<StreamRet> => {
      if (!canRunPostElevationInit(elevationReady, authReady)) {
        return of(null);
      }

      if (!userId) {
        return combineLatest([of(null), of(null)]);
      }

      return combineLatest([
        from(
          getMemberRepo()
            .getMyMember()
            .catch(() => null),
        ),
        from(
          getUserRepo()
            .getMyUser()
            .catch(() => null),
        ),
      ]);
    },
    onSuccess: (results) => {
      if (!canRunPostElevationInit(elevationReady)) {
        return;
      }
      setStreamReady(true);
      if (results === null) {
        return;
      }

      const [members, user] = results;
      produceAppState((draft) => {
        registerUsers(draft, listify(user));
        registerMembers(draft, listify(members));
      });
    },
    dependencies: [userId, authReady, elevationReady],
  });

  useAsyncEffect(async () => {
    if (!canRunPostElevationInit(elevationReady, authReady)) {
      return;
    }
    await refreshCurrentUser();
    setInitReady(true);
  }, [authReady, elevationReady]);

  useAsyncEffect(async () => {
    if (!canRunPostElevationInit(elevationReady, initReady)) {
      return;
    }
    await loadPairedRemoteDevices();
    await refreshRemoteReceiverStatus();
    const prefs = getMyUserPreferences(getAppState());
    if (
      prefs?.remoteTargetDeviceId &&
      !getAppState().pairedRemoteDeviceById[prefs.remoteTargetDeviceId]
    ) {
      await setRemoteTargetDeviceId(null);
      await setRemoteOutputEnabled(false);
    }
    const receiverStatus = getAppState().remoteReceiverStatus;
    if (prefs?.remoteReceiverAutoStart && !receiverStatus?.enabled) {
      await startRemoteReceiver(prefs.remoteReceiverPort ?? null);
    }
  }, [initReady, elevationReady]);

  useEffect(() => {
    if (
      !canRunPostElevationInit(elevationReady, streamReady, initReady) ||
      initialized
    ) {
      return;
    }
    getLogger().info("App fully initialized");
    produceAppState((draft) => {
      draft.initialized = true;
    });
  }, [streamReady, initReady, initialized, elevationReady]);

  const auth = useAppStore((state) => state.auth);
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) {
      return;
    }

    const mp = getMixpanel();
    if (!mp) {
      return;
    }

    const currentUserId = auth?.uid ?? null;
    const prevUserId = prevUserIdRef.current;
    if (prevUserId && !currentUserId) {
      mp.reset();
    }

    const identity = buildAnalyticsIdentity({
      userId: currentUserId,
      member,
      localUser,
      preferences: prefs,
      platform: getPlatform(),
      locale: detectLocale(),
    });

    if (currentUserId && currentUserId !== prevUserId) {
      mp.identify(currentUserId);
      const firstTouch = buildFirstTouchProperties(identity);
      mp.people.set_once({
        $created: new Date().toISOString(),
        ...firstTouch,
      });
      mp.register_once(firstTouch);
    }

    mp.people.set(
      buildPeopleProperties(identity, {
        email: auth?.email,
        displayName: auth?.displayName,
      }),
    );

    mp.register(buildSuperProperties(identity));

    if (versionData.state === "success") {
      mp.register({
        appVersion: versionData.data,
      });
    }

    prevUserIdRef.current = currentUserId;
  }, [initialized, auth, member, localUser, prefs, versionData]);

  const handleAddToDictionary = useCallback(async () => {
    try {
      const selectedText = await invoke<string | null>("get_selected_text");
      if (!selectedText?.trim()) {
        return;
      }

      const text = selectedText.trim();
      const newTerm: Term = {
        id: createId(),
        createdAt: new Date().toISOString(),
        sourceValue: text,
        destinationValue: "",
        isReplacement: false,
      };

      produceAppState((draft) => {
        draft.termById[newTerm.id] = newTerm;
        draft.dictionary.termIds = [newTerm.id, ...draft.dictionary.termIds];
      });

      await getTermRepo().createTerm(newTerm);
      sendPillFlashMessage(
        intl.formatMessage(
          { defaultMessage: 'Added "{text}" to dictionary' },
          { text },
        ),
      );
    } catch (error) {
      getLogger().error(`Failed to add to dictionary: ${error}`);
    }
  }, [intl]);

  useHotkeyFire({
    actionName: ADD_TO_DICTIONARY_HOTKEY,
    isDisabled: !isMainWindow,
    onFire: handleAddToDictionary,
  });

  // You cannot refresh the page in Tauri, here's a hotkey to help with that
  useKeyDownHandler({
    keys: ["r"],
    ctrl: true,
    callback: () => {
      if (getIsDevMode()) {
        showSnackbar("Refreshing application...");
        window.location.href = "/welcome";
      }
    },
  });

  // Hotkey to open settings (Cmd+, on macOS)
  useKeyDownHandler({
    keys: [","],
    meta: true,
    callback: () => {
      if (window.location.pathname !== "/dashboard/settings") {
        window.location.href = "/dashboard/settings";
      }
    },
  });

  // Background update poll. Releases land a few times a year, so a slow
  // cadence is plenty; the Settings "Check now" button covers impatience.
  useIntervalAsync(UPDATE_CHECK_INTERVAL_MS, async () => {
    // Dev builds run against an unsigned local bundle the updater endpoint
    // knows nothing about, so a check can only ever produce noise.
    if (getIsDevMode()) {
      return;
    }

    // The action syncs the tray badge itself, so a manual check from Settings
    // updates it too rather than waiting for the next poll.
    await checkForAppUpdates();
  }, []);

  useToastAction(async (payload) => {
    if (payload.action === "open_agent_settings") {
      surfaceMainWindow();
      produceAppState((draft) => {
        draft.settings.agentModeDialogOpen = true;
      });
    } else if (payload.action === "surface_window") {
      surfaceMainWindow();
    } else if (payload.action === "open_transcriptions") {
      surfaceMainWindow();
      try {
        browserRouter.navigate("/dashboard/transcriptions");
      } catch (error) {
        getLogger().warning(
          `Failed to navigate to transcriptions: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  useTauriListen<void>("tray-install-update", () => {
    if (!isMainWindow) return;
    surfaceMainWindow();
    installAvailableUpdate();
  });

  useTauriListen<void>("tray-copy-last-transcript", async () => {
    if (!isMainWindow) return;
    const [latest] = await getTranscriptionRepo().listTranscriptions({
      limit: 1,
    });
    if (latest?.transcript) {
      await invoke("copy_to_clipboard", { text: latest.transcript });
    }
  });

  const menuBarIconHidden = prefs?.menuBarIconHidden ?? false;
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_tray_visible", { visible: !menuBarIconHidden }).catch(
      console.error,
    );
  }, [menuBarIconHidden]);

  // Re-push the tray Language submenu whenever the Active Dictation Language or
  // the configured language set changes, keeping the tray correct after both
  // tray clicks and settings edits.
  const trayLanguageMenuKey = useAppStore((state) =>
    JSON.stringify(buildTrayLanguageMenuModel(state)),
  );
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_tray_language_menu", {
      items: JSON.parse(trayLanguageMenuKey),
    }).catch(console.error);
  }, [trayLanguageMenuKey]);

  useTauriListen<string>("tray-set-dictation-language", (code) => {
    if (!isMainWindow) return;
    setActiveDictationLanguage(code).catch(console.error);
  });

  // The native command reads the real window state; these events only trigger
  // a debounced re-sync after OS-driven minimize, close-to-tray, and surface
  // transitions. Rust retains both localized labels so a tray click can update
  // the item synchronously without waiting for the webview.
  useEffect(() => {
    if (!isMainWindow) return;

    const appWindow = getCurrentWindow();
    const labels = getLocalizedDashboardMenuLabels(intl);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const sync = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        commands
          .setDashboardMenuLabels(labels.openLabel, labels.hideLabel)
          .catch(console.error);
      }, 50);
    };

    sync();
    const listeners = Promise.all([
      appWindow.onFocusChanged(sync),
      appWindow.onResized(sync),
      appWindow.onCloseRequested(sync),
    ]);

    return () => {
      clearTimeout(timeoutId);
      void listeners.then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
    };
  }, [intl]);

  // ── Tray pill-visibility toggle ────────────────────────────────────────────
  // One menu item whose label states the action it performs. The persisted
  // preference is the source of truth; the tray never holds its own toggle.
  const effectivePillVisibility = getEffectivePillVisibility(
    prefs?.dictationPillVisibility,
  );

  // Read the live value inside async work. A value captured by the render that
  // registered the listener would be stale by the time a click arrives.
  const pillVisibilityRef = useRef(effectivePillVisibility);
  pillVisibilityRef.current = effectivePillVisibility;

  // Serializes tray clicks. `updateUserPreferences` writes the whole
  // preferences object, so two overlapping writes can clobber each other; and
  // AsyncLock only counts callers, it does not queue them. Chaining onto a
  // promise gives real ordering, and each link re-reads the ref so it acts on
  // the state left by the previous write rather than on what was current when
  // the user clicked.
  const pillVisibilityQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Label follows the persisted preference: startup hydration, tray clicks and
  // Settings edits all flow through here, so the tray cannot drift.
  useEffect(() => {
    if (!isMainWindow) return;
    const label = getLocalizedPillMenuLabel(effectivePillVisibility, intl);
    invoke("set_pill_visibility_menu_state", {
      label,
    }).catch(console.error);
  }, [effectivePillVisibility, intl]);

  useTauriListen<void>("tray-toggle-pill-visibility", () => {
    if (!isMainWindow) return;
    pillVisibilityQueueRef.current = pillVisibilityQueueRef.current
      .then(async () => {
        const current = pillVisibilityRef.current;
        const next = getNextPillVisibility(current);
        if (next === current) {
          return;
        }
        // On failure setDictationPillVisibility rolls the store back and
        // surfaces the existing save error, so the effect above restores the
        // previous label. The menu therefore never claims an unsaved state.
        await setDictationPillVisibility(next);
        pillVisibilityRef.current = next;
        getLogger().info(
          `Tray pill visibility: ${current} -> ${next} (${getPillMenuLabel(next)})`,
        );
      })
      .catch((error) => {
        getLogger().error(`Failed to toggle pill visibility: ${error}`);
      });
  });

  // ── Tray reset-pill-position ─────────────────────────────────────────────
  // The native pill tracks whether the user has dragged it away from its
  // default centre-bottom spawn. When it reports a position change we sync
  // the tray menu item's enabled state; when the user clicks "Reset Pill
  // Position" we forward the IPC message and the pill re-homes itself.
  useTauriListen<void>("tray-reset-pill-position", () => {
    if (!isMainWindow) return;
    const strategy =
      getMyUserPreferences(getAppState())?.pillResetMonitorStrategy ??
      "current";
    invoke("reset_pill_position", { strategy }).catch((error) => {
      getLogger().error(`Failed to reset pill position: ${error}`);
    });
  });

  useTauriListen<{
    hasSavedPosition: boolean;
    rect?: { x: number; y: number; width: number; height: number };
    monitor?: { x: number; y: number; width: number; height: number };
  }>("pill-position-changed", (event) => {
    // Pill geometry and tray menu belong to the main window's pill.
    if (!isMainWindow) return;
    setPillGeometry(event.rect ?? null, event.monitor ?? null);
    invoke("set_reset_pill_position_enabled", {
      enabled: event.hasSavedPosition,
    }).catch((error) => {
      getLogger().error(
        `Failed to update reset-pill-position menu state: ${error}`,
      );
    });
  });

  return null;
};
