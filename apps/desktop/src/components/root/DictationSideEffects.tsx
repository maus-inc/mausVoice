import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppTarget } from "@maus-inc/types";
import { delayed } from "@maus-inc/utilities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  loadManualStyleForCurrentApp,
  saveManualStyleForApp,
  tryRegisterCurrentAppTarget,
} from "../../actions/app-target.actions";
import {
  createConversation,
  loadChatMessages,
  sendChatMessage,
} from "../../actions/chat.actions";
import { refreshMember } from "../../actions/member.actions";
import { dismissToast, showToast } from "../../actions/toast.actions";
import { applyInDictationStyleSwitch } from "../../actions/tone.actions";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import { storeTranscription } from "../../actions/transcribe.actions";
import { recordStreak } from "../../actions/user.actions";
import {
  useHotkeyFire,
  useHotkeyFireMany,
  useHotkeyHold,
  useHotkeyHoldMany,
} from "../../hooks/hotkey.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { browserRouter } from "../../router";
import { createTranscriptionSession } from "../../sessions";
import { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AgentStrategy } from "../../strategies/agent.strategy";
import { BaseStrategy } from "../../strategies/base.strategy";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import { TextFieldInfo } from "../../types/accessibility.types";
import type {
  OverlayPhase,
  OverlayResolvePermissionPayload,
} from "../../types/overlay.types";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import {
  ActivationController,
  debouncedToggle,
} from "../../utils/activation.utils";
import {
  trackAgentStart,
  trackAppUsed,
  trackDictationStart,
} from "../../utils/analytics.utils";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { playAlertSound, tryPlayAudioChime } from "../../utils/audio.utils";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  getDictationRecordingTimerDurations,
  getEffectiveDictationLimitMinutes,
  getProviderRecordingTimerDurations,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import {
  createUtteranceToneSnapshots,
  getEffectiveToneIdAtFinalize,
  isActivationComboHeld,
  resolveInDictationArrowStyleSwitch,
  resolveNewlyPressedDictationArrow,
} from "../../utils/dictation-style.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { createId } from "../../utils/id.utils";
import {
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  getAdditionalLanguageEntries,
  getHotkeyCombosForAction,
  getSwitchToStyleEntries,
  OPEN_CHAT_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
} from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
  getToneIdToUse,
} from "../../utils/tone.utils";
import { withTimeout } from "../../utils/timeout.utils";
import {
  getEffectivePillVisibility,
  getIsDictationUnlocked,
  getIsOnboarded,
  getMyPreferredMicrophone,
  getMyPrimaryDictationLanguage,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { hasDictationBacklog } from "../../utils/output-routing.utils";
import { surfaceMainWindow } from "../../utils/window.utils";
import { resetHotkeyFilter } from "../../utils/hotkey-filter.utils";

type StartRecordingResponse = {
  sampleRate: number;
};

type AbortMessage = {
  title?: string;
  body: unknown;
};

type RawStopResp = {
  shouldContinue: boolean;
  abortMessage?: string;
};

type FinalizedRecording = {
  audio: StopRecordingResponse;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  toneId: string | null;
  rawTranscript: string;
  transcribeResult: TranscriptionSessionResult;
};

const FINALIZE_TIMEOUT_MS = 90_000;
const HANDLE_TRANSCRIPT_TIMEOUT_MS = 60_000;
const PHASE_HEARTBEAT_INTERVAL_MS = 5_000;
/** Dictation backlog poll interval: how often to check whether the user
 *  has focused an editable target so accumulated backlog can be drained. */
const BACKLOG_DRAIN_POLL_MS = 1_000;
const IN_DICTATION_STYLE_KEYS = ["LeftArrow", "RightArrow"];

export const DictationSideEffects = () => {
  const intl = useIntl();

  // The composer popout is a separate webview that loads the same SPA. Dictation
  // is owned by the main window only — in any other window the dictation
  // hotkeys, held-key style switching, and click-to-dictate pipeline must stay
  // inert so we never run two dictation sessions at once.
  const isMainWindow = getCurrentWindow().label === "main";

  const strategyRef = useRef<BaseStrategy | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const preDictationVolumeRef = useRef<number | null>(null);
  const recordingWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const providerWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const providerAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cancelPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isStoppingRef = useRef(false);
  const isPausedRef = useRef(false);
  // Last phase actually sent to the pill; drives the idle-reconciliation
  // heartbeat and keeps duplicate idle writes out of the pipe.
  const lastPhaseSentRef = useRef<OverlayPhase | null>(null);
  const previousStyleSwitchKeysRef = useRef<string[]>([]);
  const utteranceTonesRef = useRef(createUtteranceToneSnapshots());
  const [isStopping, setIsStopping] = useState(false);
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const isManualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );
  const isActiveSession = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const activeRecordingMode = useAppStore((state) => state.activeRecordingMode);
  const keysHeld = useAppStore((state) => state.keysHeld);
  const assistantInputMode = useAppStore((state) => state.assistantInputMode);
  const additionalLanguageEntries = useAppStore(getAdditionalLanguageEntries);
  const switchToStyleEntries = useAppStore(getSwitchToStyleEntries);
  const inDictationStyleSwitchingEnabled = useAppStore(
    (state) => state.userPrefs?.inDictationStyleSwitchingEnabled ?? false,
  );
  const dictateCombos = useAppStore((state) =>
    getHotkeyCombosForAction(state, DICTATE_HOTKEY),
  );
  const isDictationUnlocked = useAppStore(getIsDictationUnlocked);
  const isDictationInteractable = isDictationUnlocked && !isStopping;
  const pillVisibility = useAppStore((state) =>
    getEffectivePillVisibility(state.userPrefs?.dictationPillVisibility),
  );

  /**
   * A pill set to "hidden" stays off-screen even while recording, so a
   * hotkey-started dictation would have no visual feedback. Revealing it for
   * the session (without touching the persisted preference) means the first
   * shortcut use after hiding brings the pill back; it hides again when idle.
   * Resolves once the visibility change has been applied, so callers can
   * start recording only after the pill is on screen.
   */
  const revealPillForActivityIfHidden = useCallback(async () => {
    if (
      getEffectivePillVisibility(
        getAppState().userPrefs?.dictationPillVisibility,
      ) !== "hidden"
    ) {
      return;
    }
    try {
      await invoke("set_pill_visibility", { visibility: "while_active" });
    } catch (error) {
      getLogger().error(`Failed to reveal pill: ${error}`);
    }
  }, []);

  const dictationController = useMemo(
    () =>
      new ActivationController(
        async () => {
          await revealPillForActivityIfHidden();
          await startDictationRecording();
        },
        () => stopDictationRecording(),
        // Hold-to-talk: dictation records while the hotkey (Fn) is held and stops on release.
        true,
      ),
    [revealPillForActivityIfHidden],
  );

  const agentController = useMemo(
    () =>
      new ActivationController(
        async () => {
          await revealPillForActivityIfHidden();
          await startAgentRecording();
        },
        () => stopAgentRecording(),
      ),
    [revealPillForActivityIfHidden],
  );

  const additionalLanguageControllers = useMemo(
    () =>
      additionalLanguageEntries.map((entry) => ({
        actionName: entry.actionName,
        controller: new ActivationController(
          async () => {
            await revealPillForActivityIfHidden();
            await startRecording({
              mode: "dictate",
              language: entry.language,
            });
          },
          () => stopRecording(),
        ),
      })),
    [additionalLanguageEntries, revealPillForActivityIfHidden],
  );

  const restoreSystemVolume = useCallback(() => {
    const savedVolume = preDictationVolumeRef.current;
    preDictationVolumeRef.current = null;
    if (savedVolume !== null) {
      invoke("set_system_volume", { volume: savedVolume }).catch((e) =>
        getLogger().verbose(`Failed to restore system volume: ${e}`),
      );
    }
  }, []);

  const dimSystemVolume = useCallback(async () => {
    const dimLevel = getAppState().userPrefs?.dictationAudioDim ?? 1.0;
    if (dimLevel >= 1.0) return;

    try {
      const currentVolume = await invoke<number>("get_system_volume");
      preDictationVolumeRef.current = currentVolume;
      const dimmedVolume = currentVolume * dimLevel;
      await invoke("set_system_volume", { volume: dimmedVolume });
    } catch (e) {
      getLogger().verbose(`Failed to dim system volume: ${e}`);
    }
  }, []);

  const clearUserRecordingTimers = useCallback(() => {
    if (recordingWarningTimerRef.current) {
      clearTimeout(recordingWarningTimerRef.current);
      recordingWarningTimerRef.current = null;
    }
    if (recordingAutoStopTimerRef.current) {
      clearTimeout(recordingAutoStopTimerRef.current);
      recordingAutoStopTimerRef.current = null;
    }
  }, []);

  const clearProviderRecordingTimers = useCallback(() => {
    if (providerWarningTimerRef.current) {
      clearTimeout(providerWarningTimerRef.current);
      providerWarningTimerRef.current = null;
    }
    if (providerAutoStopTimerRef.current) {
      clearTimeout(providerAutoStopTimerRef.current);
      providerAutoStopTimerRef.current = null;
    }
  }, []);

  const clearRecordingTimers = useCallback(() => {
    clearUserRecordingTimers();
    clearProviderRecordingTimers();
  }, [clearProviderRecordingTimers, clearUserRecordingTimers]);

  useEffect(() => () => clearRecordingTimers(), [clearRecordingTimers]);

  const clearCancelPromptTimer = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearTimeout(cancelPromptTimerRef.current);
      cancelPromptTimerRef.current = null;
    }
  }, []);

  const clearUtteranceToneSnapshots = useCallback(() => {
    utteranceTonesRef.current.clear();
  }, []);

  const clearRecordingState = useCallback(() => {
    isPausedRef.current = false;
    produceAppState((draft) => {
      draft.activeRecordingMode = null;
      draft.dictationLanguageOverride = null;
      draft.assistantInputMode = "voice";
    });
  }, []);

  const hardResetHotkeyState = useCallback(() => {
    dictationController.forceReset();
    agentController.forceReset();
    for (const { controller } of additionalLanguageControllers) {
      controller.forceReset();
    }

    produceAppState((draft) => {
      draft.keysHeld = [];
    });

    invoke("reset_key_listener_state").catch((error) =>
      getLogger().verbose(`Failed to reset key listener state: ${error}`),
    );
    resetHotkeyFilter();
  }, [additionalLanguageControllers, agentController, dictationController]);

  /**
   * Sends a phase to the pill with one immediate retry, and records it for
   * the reconciliation heartbeat. A failed pipe write must not leave the
   * pill stuck on a stale phase.
   */
  const sendPhaseToPill = useCallback(async (phase: OverlayPhase) => {
    lastPhaseSentRef.current = phase;
    try {
      await invoke<void>("set_phase", { phase });
    } catch (error) {
      getLogger().warning(
        `Failed to send phase ${phase} to pill: ${error}; retrying once`,
      );
      try {
        await invoke<void>("set_phase", { phase });
      } catch (retryError) {
        getLogger().error(
          `Failed to send phase ${phase} to pill on retry: ${retryError}`,
        );
      }
    }
  }, []);

  // Idle-reconciliation heartbeat: if nothing is recording and the pill was
  // not last told to idle, re-send idle so a dropped phase IPC self-heals.
  useEffect(() => {
    if (!isMainWindow) return;
    const interval = setInterval(() => {
      const state = getAppState();
      if (state.activeRecordingMode !== null) {
        return;
      }
      if (lastPhaseSentRef.current === "idle") {
        return;
      }
      void sendPhaseToPill("idle");
    }, PHASE_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sendPhaseToPill]);

  // Dictation backlog drain poll: while a session is active and there is a
  // non-empty backlog, periodically probe whether the user has focused an
  // editable target.  When they have, drain the full backlog once.
  // This covers the case where the user clicks an input while not speaking
  // (no interim segment fires to trigger the drain).
  useEffect(() => {
    if (!isMainWindow || !isActiveSession) return;
    const interval = setInterval(() => {
      const strategy = strategyRef.current;
      if (!(strategy instanceof DictationStrategy)) return;
      if (!hasDictationBacklog()) return;
      strategy.checkAndDrainBacklog().catch((error: unknown) => {
        getLogger().warning(`Backlog drain poll failed: ${error}`);
      });
    }, BACKLOG_DRAIN_POLL_MS);
    return () => clearInterval(interval);
  }, [isMainWindow, isActiveSession]);

  const abortRecording = useCallback(
    async (message?: AbortMessage) => {
      getLogger().info(
        `Aborting recording (hasSession=${!!sessionRef.current}, hasStrategy=${!!strategyRef.current}${message ? `, reason=${String(message.body).slice(0, 120)}` : ""})`,
      );
      clearRecordingTimers();
      clearCancelPromptTimer();
      hardResetHotkeyState();
      restoreSystemVolume();
      await sendPhaseToPill("idle");
      invoke("stop_recording").catch((e) =>
        getLogger().verbose(`stop_recording failed during abort: ${e}`),
      );

      // Deterministic cleanup: clear the refs first so no other path can
      // reach the session mid-cleanup, then guard each cleanup call.
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      strategyRef.current = null;
      sessionRef.current = null;
      clearUtteranceToneSnapshots();

      try {
        session?.cleanup();
      } catch (error) {
        getLogger().warning(`Session cleanup failed during abort: ${error}`);
      }
      try {
        await strategy?.cleanup();
      } catch (error) {
        getLogger().warning(`Strategy cleanup failed during abort: ${error}`);
      }

      clearRecordingState();

      if (message) {
        playAlertSound();
        showToast({
          message: String(message.body),
          toastType: "error",
          duration: 8_000,
        });
      }
    },
    [
      clearCancelPromptTimer,
      clearRecordingState,
      clearRecordingTimers,
      clearUtteranceToneSnapshots,
      hardResetHotkeyState,
      restoreSystemVolume,
      sendPhaseToPill,
      intl,
    ],
  );

  const captureStopRecordingInfo = useCallback(async (): Promise<{
    audio: StopRecordingResponse | null;
    a11yInfo: TextFieldInfo | null;
    appTarget: AppTarget | null;
  }> => {
    const [audio, a11yInfo, appTarget] = await getLogger().stopwatch(
      "stopRecording",
      async () => {
        let audio: StopRecordingResponse | null = null;
        let a11yInfo: TextFieldInfo | null = null;
        let appTarget: AppTarget | null = null;
        try {
          tryPlayAudioChime("stop_recording_clip");

          getLogger().verbose("Invoking stop_recording and fetching a11y info");
          const [, outAudio, outA11yInfo, outAppTarget] = await Promise.all([
            strategyRef.current?.setPhase("loading"),
            invoke<StopRecordingResponse>("stop_recording"),
            invoke<TextFieldInfo>("get_text_field_info").catch((error) => {
              getLogger().verbose(`Failed to get text field info: ${error}`);
              return null;
            }),
            tryRegisterCurrentAppTarget().catch((error) => {
              getLogger().verbose(`Failed to get current app target: ${error}`);
              return null;
            }),
          ]);

          audio = outAudio;
          a11yInfo = outA11yInfo;
          appTarget = outAppTarget;
          getLogger().verbose(
            `Recording stopped (hasSamples=${!!audio?.samples})`,
          );
        } catch (error) {
          getLogger().error(`Failed to stop recording: ${error}`);
          showToast({
            message: intl.formatMessage({
              defaultMessage: "Failed to stop recording",
            }),
            toastType: "error",
            duration: 8_000,
          });
        }

        return [audio, a11yInfo, appTarget];
      },
    );

    return { audio, a11yInfo, appTarget };
  }, [intl]);

  const processFinalizedRecording = useCallback(
    async ({
      audio,
      a11yInfo,
      appTarget,
      toneId,
      rawTranscript,
      transcribeResult,
    }: FinalizedRecording): Promise<RawStopResp> => {
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      if (!session || !strategy) {
        getLogger().warning(
          `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
        );
        return { shouldContinue: false };
      }

      if (getAppState().activeRecordingMode === "agent") {
        await sendPhaseToPill("idle");
      }

      getLogger().info("Post-processing transcript");
      const result = await withTimeout(
        strategy.handleTranscript({
          rawTranscript,
          processedTranscript: transcribeResult.processedTranscript,
          serverPostProcessMetadata: transcribeResult.postProcessMetadata,
          toneId,
          a11yInfo,
          currentApp: appTarget,
          loadingToken: null,
          audio,
          transcriptionMetadata: transcribeResult.metadata,
          transcriptionWarnings: transcribeResult.warnings,
        }),
        HANDLE_TRANSCRIPT_TIMEOUT_MS,
        "Transcript post-processing",
      );

      const transcript = result.transcript;
      const sanitizedTranscript = result.sanitizedTranscript;
      const postProcessMetadata = result.postProcessMetadata;
      const postProcessWarnings = result.postProcessWarnings;
      getLogger().verbose(
        `Post-processing complete: transcript=${transcript ? `${transcript.length} chars` : "empty"}, warnings=${postProcessWarnings.length}`,
      );

      if (strategy.shouldStoreTranscript()) {
        getLogger().verbose("Storing transcription");
        storeTranscription({
          audio,
          rawTranscript: rawTranscript ?? null,
          sanitizedTranscript,
          transcript,
          transcriptionMetadata: transcribeResult.metadata,
          postProcessMetadata,
          warnings: [...transcribeResult.warnings, ...postProcessWarnings],
          remoteStatus: result.remoteStatus,
          remoteDeviceId: result.remoteDeviceId,
        });
      }

      refreshMember();
      return {
        shouldContinue: result.shouldContinue,
      };
    },
    [sendPhaseToPill],
  );

  const finalizeAndPostProcess = useCallback(
    async ({
      audio,
      a11yInfo,
      appTarget,
    }: {
      audio: StopRecordingResponse;
      a11yInfo: TextFieldInfo | null;
      appTarget: AppTarget | null;
    }): Promise<RawStopResp> => {
      getLogger().info("Finalizing transcription session");
      trackAppUsed(appTarget?.name ?? "Unknown");

      if (appTarget) {
        saveManualStyleForApp(appTarget);
      }

      // Manual mode: the tone selected at recording START styles the whole
      // utterance, so a mid-dictation switch (pill / hotkey / Left-Right)
      // only affects the NEXT recording, matching the label shown at start.
      // The stop snapshot is a race-safety fallback if start was missed.
      // Automatic mode prefers the app-target tone and falls back to the
      // live selection when the app has none. Streamed interim text is
      // never restyled here — DictationStrategy skips post-processing once
      // segments are inserted.
      const utteranceTones = utteranceTonesRef.current.read();
      const toneId = getEffectiveToneIdAtFinalize({
        stylingMode: getEffectiveStylingMode(getAppState()),
        toneIdAtStart: utteranceTones.start,
        toneIdAtStop: utteranceTones.stop,
        liveSelectedToneId: getManuallySelectedToneId(getAppState()),
        appTargetToneId: appTarget?.toneId ?? null,
      });
      const transcribeResult = await withTimeout(
        sessionRef.current?.finalize(audio, {
          toneId,
          a11yInfo,
        }) ?? Promise.resolve(undefined),
        FINALIZE_TIMEOUT_MS,
        "Transcription finalize",
      );
      const rawTranscript = transcribeResult?.rawTranscript;
      getLogger().verbose(
        `Transcription result: rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}, toneId=${toneId ?? "none"}, app=${appTarget?.name ?? "unknown"}`,
      );

      if (!rawTranscript || !transcribeResult) {
        getLogger().warning("stopRecordingRaw: no rawTranscript from finalize");
        return { shouldContinue: false };
      }

      return processFinalizedRecording({
        audio,
        a11yInfo,
        appTarget,
        toneId,
        rawTranscript,
        transcribeResult,
      });
    },
    [processFinalizedRecording],
  );

  const stopRecordingRaw = useCallback(async (): Promise<RawStopResp> => {
    getLogger().info("Stopping recording");
    clearRecordingTimers();
    restoreSystemVolume();

    try {
      const { audio, a11yInfo, appTarget } = await captureStopRecordingInfo();
      if (!audio) {
        getLogger().warning("stopRecordingRaw: no audio data received");
        return {
          shouldContinue: false,
          abortMessage: "No audio data received",
        };
      }
      return await finalizeAndPostProcess({ audio, a11yInfo, appTarget });
    } catch (error) {
      const errorName = error instanceof Error ? ` [name=${error.name}]` : "";
      getLogger().error(`Error during stopRecording: ${error}${errorName}`);
      clearUtteranceToneSnapshots();
      return {
        shouldContinue: false,
        abortMessage: String(error),
      };
    } finally {
      // Phase convergence: every stop path (success, error, watchdog
      // timeout) must return the pill to idle.
      await sendPhaseToPill("idle");
    }
  }, [
    captureStopRecordingInfo,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    finalizeAndPostProcess,
    restoreSystemVolume,
    sendPhaseToPill,
  ]);

  const stopRecording = useCallback(async () => {
    if (isStoppingRef.current) {
      getLogger().info("stopRecording skipped (already stopping)");
      return;
    }

    const hasOnboarded = getIsOnboarded(getAppState());
    if (hasOnboarded) {
      delayed(2000).then(() => recordStreak());
    }

    getLogger().info("stopRecording entered");
    isStoppingRef.current = true;
    setIsStopping(true);
    // Capture the live tone at stop as a race-safety fallback. The whole
    // utterance is styled by the tone snapshotted at recording START, so a
    // mid-dictation style switch only affects the next recording.
    utteranceTonesRef.current.snapshotAtStop(
      getToneIdToUse(getAppState(), {
        currentAppToneId: null,
      }),
    );
    try {
      const res = await stopRecordingRaw().catch((error) => {
        getLogger().error(
          `Error during stopRecording: ${error}${error instanceof Error ? ` [name=${error.name}, stack=${error.stack}]` : ""}`,
        );
        return {
          shouldContinue: false,
          abortMessage: String(error),
        };
      });

      getLogger().info(
        `stopRecording result: shouldContinue=${res.shouldContinue}, abortMessage=${res.abortMessage ?? "none"}`,
      );
      if (!res.shouldContinue) {
        await abortRecording(
          res.abortMessage ? { body: res.abortMessage } : undefined,
        );
      }
    } finally {
      // Timers must be cleared even when the transcribe chain fails or the
      // watchdog fires, so no stale auto-stop can fire into the next session.
      clearRecordingTimers();
      hardResetHotkeyState();
      isStoppingRef.current = false;
      setIsStopping(false);
      // Finalize has already read the snapshots. Drop them so a later
      // session cannot inherit this utterance's tone if start is raced.
      clearUtteranceToneSnapshots();
    }
  }, [
    abortRecording,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    hardResetHotkeyState,
    stopRecordingRaw,
    setIsStopping,
  ]);

  const startUserRecordingTimers = useCallback(() => {
    clearUserRecordingTimers();

    const state = getAppState();
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    const dictationLimitMinutes = shouldEnableDictationLimit(
      transcriptionPrefs.mode,
    )
      ? getEffectiveDictationLimitMinutes(preferences)
      : DEFAULT_DICTATION_LIMIT_MINUTES;
    const { warningDurationMs, autoStopDurationMs } =
      getDictationRecordingTimerDurations(dictationLimitMinutes);

    if (warningDurationMs !== null) {
      recordingWarningTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording duration warning (${dictationLimitMinutes} min limit)`,
        );
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording will stop in 60 seconds",
          }),
          toastType: "info",
          duration: 5_000,
        });
      }, warningDurationMs);
    }

    if (autoStopDurationMs !== null) {
      recordingAutoStopTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording auto-stopped (${dictationLimitMinutes} min limit)`,
        );
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording stopped: duration limit reached",
          }),
          toastType: "info",
          duration: 5_000,
        });
        stopRecording();
      }, autoStopDurationMs);
    }
  }, [clearUserRecordingTimers, intl, stopRecording]);

  const startProviderRecordingTimers = useCallback(() => {
    clearProviderRecordingTimers();

    const providerLimitMs =
      sessionRef.current?.getMaximumRecordingDurationMs?.() ?? null;
    const { warningDurationMs, autoStopDurationMs } =
      getProviderRecordingTimerDurations(providerLimitMs);
    if (autoStopDurationMs === null) {
      return;
    }

    if (warningDurationMs !== null) {
      providerWarningTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Provider recording duration warning (${providerLimitMs} ms limit)`,
        );
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Provider limit: recording will stop in 60 seconds",
          }),
          toastType: "info",
          duration: 5_000,
        });
      }, warningDurationMs);
    }
    providerAutoStopTimerRef.current = setTimeout(() => {
      getLogger().warning(
        `Recording auto-stopped at provider limit (${providerLimitMs} ms)`,
      );
      showToast({
        message: intl.formatMessage({
          defaultMessage: "Recording stopped: provider duration limit reached",
        }),
        toastType: "info",
        duration: 5_000,
      });
      stopRecording();
    }, autoStopDurationMs);
  }, [clearProviderRecordingTimers, intl, stopRecording]);

  const startRecording = useCallback(
    async (args: { mode: RecordingMode; language?: string | null }) => {
      const state = getAppState();
      const mode = args.mode;
      const language = args.language || getMyPrimaryDictationLanguage(state);
      produceAppState((draft) => {
        draft.activeRecordingMode = mode;
        draft.dictationLanguageOverride = language;
      });

      let strategy: BaseStrategy | null = strategyRef.current ?? null;
      if (!strategy) {
        if (mode === "agent") {
          strategy = new AgentStrategy();
        } else {
          strategy = new DictationStrategy();
        }
      }

      const validationError = strategy.validateAvailability();
      if (validationError) {
        abortRecording({
          title: validationError.title,
          body: validationError.body,
        });
        return;
      }

      if (
        mode === "dictate" &&
        !state.onboarding.dictationOverrideEnabled &&
        !state.local.disableAutoStyleLoading
      ) {
        await loadManualStyleForCurrentApp();
      }

      // Seed the start snapshot after app-based style load. This is the
      // authoritative style for the whole utterance; a mid-dictation switch
      // styles the next recording only. Stop captures a fallback snapshot.
      utteranceTonesRef.current.seed(
        getToneIdToUse(getAppState(), {
          currentAppToneId: null,
        }),
      );

      const preferredMicrophone = getMyPreferredMicrophone(state);
      const transcriptPrefs = getTranscriptionPrefs(state);
      try {
        getLogger().info(`Transcription prefs: mode=${transcriptPrefs.mode}`);
        const session = createTranscriptionSession(transcriptPrefs);
        getLogger().info(
          `Created transcription session: ${session.constructor.name}`,
        );

        tryPlayAudioChime("start_recording_clip");
        if (session.supportsStreaming()) {
          session.setInterimResultCallback((segment) => {
            strategy.handleInterimSegment(segment);
          });
        }

        sessionRef.current = session;
        strategyRef.current = strategy;
        await strategy.onBeforeStart();

        getLogger().info(
          `Starting recording (mic=${preferredMicrophone ?? "default"})`,
        );
        isPausedRef.current = false;
        const [, startRecordingResult] = await Promise.all([
          strategy.setPhase("recording"),
          invoke<StartRecordingResponse>("start_recording", {
            args: { preferredMicrophone },
          }).then((result) => {
            // The phase update can outlive microphone startup. Anchor provider
            // wall-clock limits at the instant native capture succeeds rather
            // than waiting for the other Promise.all branch.
            if (
              sessionRef.current === session &&
              strategyRef.current === strategy
            ) {
              startProviderRecordingTimers();
            }
            return result;
          }),
        ]);

        const sampleRate = startRecordingResult.sampleRate;
        getLogger().verbose(`Recording started (sampleRate=${sampleRate})`);

        // A stop/abort can arrive while `start_recording` is still opening
        // the mic (WASAPI init can take >1s on loaded machines).
        // `abortRecording` nulls the refs, so require the refs to still match
        // this invocation's session before continuing. Reading and invoking a
        // nullable current ref here previously crashed when the user stopped
        // mid-initialization.
        if (
          sessionRef.current !== session ||
          strategyRef.current !== strategy
        ) {
          getLogger().warning(
            "Recording start raced an abort or replacement; skipping stale session start",
          );
          return;
        }
        const startedSession = session;
        const startedStrategy = strategy;

        await startedSession.onRecordingStart(sampleRate);

        if (
          sessionRef.current !== startedSession ||
          strategyRef.current !== startedStrategy
        ) {
          getLogger().warning(
            "Session was aborted while starting; skipping timers and volume dim",
          );
          // The abort path cleans whatever was current in the refs; release
          // this (now-orphaned) session defensively — cleanup is idempotent.
          startedSession.cleanup();
          return;
        }

        // Keep the user-configured active-audio timers at their established
        // start point after session initialization succeeds.
        startUserRecordingTimers();
        dimSystemVolume();
      } catch (error) {
        getLogger().error(`Failed to start recording: ${error}`);

        sessionRef.current?.cleanup();
        sessionRef.current = null;
        strategyRef.current = null;
        clearRecordingState();
        abortRecording();

        hardResetHotkeyState();
        clearRecordingTimers();
        invoke("stop_recording").catch((e) =>
          getLogger().verbose(
            `stop_recording failed during error handling: ${e}`,
          ),
        );

        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording failed",
          }),
          toastType: "error",
          duration: 8_000,
        });
      }
    },
    [
      abortRecording,
      clearRecordingState,
      clearRecordingTimers,
      dimSystemVolume,
      hardResetHotkeyState,
      intl,
      startProviderRecordingTimers,
      startUserRecordingTimers,
    ],
  );

  const startDictationRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring start");
      return;
    }

    getLogger().info("Starting dictation recording");
    trackDictationStart();
    produceAppState((draft) => {
      draft.local.lastDictatedAt = Date.now();
    });

    await startRecording({ mode: "dictate" });
  }, [startRecording]);

  const stopDictationRecording = useCallback(async () => {
    getLogger().info("Stopping dictation recording");
    await stopRecording();
  }, [stopRecording]);

  const startAgentRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring agent start");
      return;
    }

    if (state.assistantInputMode === "type") {
      getLogger().info("Switching from type mode back to voice mode");
      produceAppState((draft) => {
        draft.assistantInputMode = "voice";
      });
    }

    getLogger().info("Starting agent recording");
    trackAgentStart();
    await startRecording({ mode: "agent" });
  }, [startRecording]);

  const stopAgentRecording = useCallback(async () => {
    getLogger().info("Stopping agent recording");
    await stopRecording();
  }, [stopRecording]);

  const handleSwitchWritingStyleForward = useCallback(
    () =>
      applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: 1 }),
    [],
  );

  const handleSwitchWritingStyleBackward = useCallback(
    () =>
      applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: -1 }),
    [],
  );

  const promptCancelTranscription = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearCancelPromptTimer();
      dismissToast();
      abortRecording();
      return;
    }

    const CANCEL_PROMPT_DURATION = 5_000;
    cancelPromptTimerRef.current = setTimeout(() => {
      cancelPromptTimerRef.current = null;
    }, CANCEL_PROMPT_DURATION);

    void showToast({
      message: intl.formatMessage({
        defaultMessage: "Press cancel again to discard transcript",
      }),
      toastType: "info",
      action: "confirm_cancel_transcription",
      duration: CANCEL_PROMPT_DURATION,
    }).catch((error) => {
      getLogger().error(`Failed to show cancel transcription toast: ${error}`);
    });
  }, [intl]);

  useEffect(() => {
    const previous = new Set(
      previousStyleSwitchKeysRef.current.map((key) => key.toLowerCase()),
    );
    const current = new Set(keysHeld.map((key) => key.toLowerCase()));
    // Combos are subscribed via `dictateCombos` so we don't rebuild them
    // on every keysHeld change. While dictation is active and the
    // activation key is held, Left/Right cycles the writing style.
    const activationHeld = isActivationComboHeld(dictateCombos, current);
    const newlyPressed = resolveNewlyPressedDictationArrow(current, previous);
    const arrowDirection = resolveInDictationArrowStyleSwitch({
      enabled: inDictationStyleSwitchingEnabled,
      isMainWindow,
      isActiveDictateSession:
        isActiveSession && activeRecordingMode === "dictate",
      isManualStyling,
      activationHeld,
      newlyPressed,
    });
    if (arrowDirection === "forward") {
      void applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    } else if (arrowDirection === "backward") {
      void applyInDictationStyleSwitch({ channel: "arrows", direction: -1 });
    }

    previousStyleSwitchKeysRef.current = keysHeld;
  }, [
    // `previousStyleSwitchKeysRef` is intentionally excluded: it is a
    // mutation-based snapshot of the prior `keysHeld` updated at the end of this
    // effect, so including it would trigger a render loop.
    activeRecordingMode,
    dictateCombos,
    inDictationStyleSwitchingEnabled,
    isActiveSession,
    isMainWindow,
    isManualStyling,
    keysHeld,
  ]);

  useHotkeyFireMany({
    actions: switchToStyleEntries.map((entry) => ({
      actionName: entry.actionName,
      onFire: () => {
        void applyInDictationStyleSwitch({
          channel: "hotkey",
          toneId: entry.toneId,
        });
      },
    })),
    isDisabled: !isDictationUnlocked || !isMainWindow,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling || !isMainWindow,
    onFire: handleSwitchWritingStyleForward,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling || !isMainWindow,
    onFire: handleSwitchWritingStyleBackward,
  });

  useHotkeyHold({
    actionName: DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      activeRecordingMode === "agent" ||
      !isMainWindow,
    controller: dictationController,
    // Only the two style-switch arrows may be held in addition to the
    // activation key, and only after dictation is already active. This keeps
    // Fn+any-key from becoming an accidental hold-to-talk gesture.
    allowedAdditionalKeys:
      inDictationStyleSwitchingEnabled &&
      isManualStyling &&
      activeRecordingMode === "dictate"
        ? IN_DICTATION_STYLE_KEYS
        : undefined,
  });

  useHotkeyHold({
    actionName: AGENT_DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      !assistantModeEnabled ||
      activeRecordingMode === "dictate" ||
      !isMainWindow,
    controller: agentController,
  });

  useHotkeyFire({
    actionName: CANCEL_TRANSCRIPTION_HOTKEY,
    isDisabled: !isActiveSession || !isMainWindow,
    onFire: promptCancelTranscription,
  });

  useHotkeyHoldMany({
    isDisabled:
      !isDictationInteractable ||
      activeRecordingMode === "agent" ||
      !isMainWindow,
    actions: additionalLanguageControllers,
  });

  // Native combo sync lives in AppSideEffects: it subscribes to every
  // grab-relevant input (session state, styling mode, unlock state, hotkey
  // map, strategy) and repushes on any change, so a per-component effect keyed
  // to just recording/styling state can't leave the listener stale.

  const openPillConversation = useCallback(
    async (conversationId?: string) => {
      const id = conversationId ?? getAppState().pillConversationId;
      if (id) {
        void loadChatMessages(id);
        browserRouter.navigate(`/dashboard/chats?id=${encodeURIComponent(id)}`);
      }
      await surfaceMainWindow();
      await abortRecording();
    },
    [abortRecording],
  );

  useTauriListen<void>("assistant-mode-close", async () => {
    if (!isMainWindow) return;
    await abortRecording();
  });

  useTauriListen<void>("assistant-enable-type-mode", async () => {
    if (!isMainWindow) return;
    getLogger().info("Switching to type mode");

    // Stop the microphone/transcription without tearing down the assistant panel
    clearRecordingTimers();
    hardResetHotkeyState();
    invoke<void>("set_phase", { phase: "idle" }).catch(console.error);
    invoke("stop_recording").catch((e) =>
      getLogger().verbose(
        `stop_recording failed during type mode switch: ${e}`,
      ),
    );
    sessionRef.current?.cleanup();
    sessionRef.current = null;
    clearUtteranceToneSnapshots();

    produceAppState((draft) => {
      draft.assistantInputMode = "type";
    });
  });

  useTauriListen<{ text: string }>(
    "assistant-typed-message",
    async (payload) => {
      if (!isMainWindow) return;
      const { text } = payload;
      if (!text.trim()) return;

      let conversationId = getAppState().pillConversationId;
      if (!conversationId) {
        const now = new Date().toISOString();
        const conversation = await createConversation({
          id: createId(),
          title: intl.formatMessage({
            defaultMessage: "New conversation",
          }),
          createdAt: now,
          updatedAt: now,
        });
        conversationId = conversation.id;
        produceAppState((draft) => {
          draft.pillConversationId = conversation.id;
        });
      }

      getLogger().info(`Sending typed message (${text.length} chars)`);
      sendChatMessage(conversationId, text).catch((error) => {
        getLogger().error(`Failed to send typed message: ${error}`);
      });
    },
  );

  useTauriListen<{ conversationId: string }>(
    "open-pill-conversation",
    (payload) => {
      if (!isMainWindow) return;
      openPillConversation(payload.conversationId);
    },
  );

  useHotkeyFire({
    actionName: OPEN_CHAT_HOTKEY,
    isDisabled: !isActiveSession || !isMainWindow,
    onFire: openPillConversation,
  });

  const pauseDictation = useCallback(async () => {
    if (isPausedRef.current || isStoppingRef.current) {
      return;
    }
    if (!sessionRef.current || !strategyRef.current) {
      return;
    }
    if (getAppState().activeRecordingMode === null) {
      return;
    }
    try {
      getLogger().info("Pausing dictation");
      // Hold mic capture without finalizing the session so the user can resume.
      await invoke("pause_recording");
      isPausedRef.current = true;
      // User-configured timers measure active audio. Provider hard limits are
      // wall-clock limits and intentionally continue while paused.
      clearUserRecordingTimers();
      // Keep the voice field fully open and slide the style bar in via paused phase.
      await strategyRef.current.setPhase("paused");
      showToast({
        message: intl.formatMessage({
          defaultMessage: "Dictation paused",
        }),
        toastType: "info",
        duration: 2_000,
      });
    } catch (error) {
      getLogger().error(`Failed to pause dictation: ${error}`);
    }
  }, [clearUserRecordingTimers, intl]);

  const resumeDictation = useCallback(async () => {
    if (!isPausedRef.current || isStoppingRef.current) {
      return;
    }
    if (!sessionRef.current || !strategyRef.current) {
      return;
    }
    try {
      getLogger().info("Resuming dictation");
      await invoke("resume_recording");
      isPausedRef.current = false;
      await strategyRef.current.setPhase("recording");
      startUserRecordingTimers();
    } catch (error) {
      getLogger().error(`Failed to resume dictation: ${error}`);
      showToast({
        message: intl.formatMessage({
          defaultMessage: "Could not resume dictation",
        }),
        toastType: "error",
        duration: 5_000,
      });
    }
  }, [intl, startUserRecordingTimers]);

  useTauriListen<void>("cancel-dictation", () => {
    if (!isMainWindow) return;
    abortRecording();
  });

  useTauriListen<void>("pause-dictation", () => {
    if (!isMainWindow) return;
    void pauseDictation();
  });

  useTauriListen<void>("resume-dictation", () => {
    if (!isMainWindow) return;
    void resumeDictation();
  });

  useToastAction(async (payload) => {
    if (payload.action === "confirm_cancel_transcription") {
      if (!isMainWindow) return;
      await abortRecording();
    }
  });

  useTauriListen<void>("on-click-dictate", () => {
    if (isMainWindow && isDictationInteractable) {
      debouncedToggle("dictation", dictationController);
    }
  });

  useTauriListen<void>("on-click-agent-talk", () => {
    if (isMainWindow && isDictationInteractable) {
      debouncedToggle("agent", agentController);
    }
  });

  useTauriListen<void>("tone-switch-forward", () => {
    if (!isMainWindow) return;
    void applyInDictationStyleSwitch({ channel: "pill", direction: 1 });
  });

  useTauriListen<void>("tone-switch-backward", () => {
    if (!isMainWindow) return;
    void applyInDictationStyleSwitch({ channel: "pill", direction: -1 });
  });

  useTauriListen<OverlayResolvePermissionPayload>(
    "overlay-resolve-permission",
    (payload) => {
      if (!isMainWindow) return;
      if (payload.alwaysAllow) {
        const permission =
          getAppState().toolPermissionById[payload.permissionId];
        if (permission) {
          setToolAlwaysAllow({
            toolId: permission.toolId,
            params: permission.params,
            allowed: true,
            scope: `conversation:${permission.conversationId}`,
          });
        }
      }
      resolveToolPermission(payload.permissionId, payload.status);
    },
  );

  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_pill_visibility", { visibility: pillVisibility }).catch(
      console.error,
    );
  }, [pillVisibility]);

  const pillHasContent = useAppStore((state) => {
    if (!state.pillConversationId) return false;
    const ids =
      state.chatMessageIdsByConversationId[state.pillConversationId] ?? [];
    if (ids.length > 0) return true;
    return Object.values(state.toolPermissionById).some(
      (p) =>
        p.conversationId === state.pillConversationId && p.status === "pending",
    );
  });

  useEffect(() => {
    if (!isMainWindow) return;
    let size: string;
    if (activeRecordingMode !== "agent") {
      size = "dictation";
    } else if (assistantInputMode === "type") {
      size = "assistant_typing";
    } else if (pillHasContent) {
      size = "assistant_expanded";
    } else {
      size = "assistant_compact";
    }
    invoke("set_pill_window_size", { size }).catch(console.error);
  }, [activeRecordingMode, pillHasContent, assistantInputMode]);

  // Sync style info to native GTK4 pill
  const pillStyleCount = useAppStore((state) => {
    if (getEffectiveStylingMode(state) !== "manual") return 0;
    return getActiveManualToneIds(state).length;
  });
  const pillStyleName = useAppStore((state) => {
    const toneId = getManuallySelectedToneId(state);
    return getToneById(state, toneId)?.name ?? "-";
  });

  useEffect(() => {
    if (!isMainWindow) return;
    invoke("notify_pill_style_info", {
      count: pillStyleCount,
      name: pillStyleName,
    }).catch(console.error);
  }, [pillStyleCount, pillStyleName]);

  return null;
};
