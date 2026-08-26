import { invoke } from "@tauri-apps/api/core";
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
import {
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "../../actions/tone.actions";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import { storeTranscription } from "../../actions/transcribe.actions";
import { recordStreak } from "../../actions/user.actions";
import {
  useHotkeyFire,
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
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { createId } from "../../utils/id.utils";
import {
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  getAdditionalLanguageEntries,
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
import { surfaceMainWindow } from "../../utils/window.utils";

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

type HandleEmptyResultInput = {
  audio: StopRecordingResponse;
  transcribeResult: TranscriptionSessionResult | undefined;
  strategy: BaseStrategy;
  formatMessage: (descriptor: { defaultMessage: string }) => string;
  showToast: (options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
  }) => Promise<void> | void;
  storeTranscriptionFn: typeof storeTranscription;
  emitFailed: () => Promise<void> | void;
  refreshMember: () => void;
};

export const handleEmptyTranscriptionResult = async (
  input: HandleEmptyResultInput,
): Promise<{ handled: boolean }> => {
  const { audio, transcribeResult, strategy, formatMessage, showToast } = input;
  const rawTranscript = transcribeResult?.rawTranscript;
  const transcriptionWarnings = transcribeResult?.warnings ?? [];
  if (rawTranscript) {
    return { handled: false };
  }
  if (transcriptionWarnings.length === 0) {
    return { handled: false };
  }

  getLogger().warning(
    `stopRecordingRaw: empty rawTranscript with ${transcriptionWarnings.length} warning(s); preserving recording`,
  );
  await showToast({
    message: formatMessage({
      defaultMessage:
        "Transcription failed. Your recording is saved so you can retry.",
    }),
    toastType: "error",
    duration: 8_000,
  });

  if (strategy.shouldStoreTranscript()) {
    await input.storeTranscriptionFn({
      audio,
      rawTranscript: null,
      sanitizedTranscript: null,
      transcript: null,
      transcriptionMetadata: transcribeResult?.metadata ?? {},
      postProcessMetadata: {},
      warnings: transcriptionWarnings,
      remoteStatus: null,
      remoteDeviceId: null,
    });
  }

  await input.emitFailed();
  input.refreshMember();
  return { handled: true };
};

const FINALIZE_TIMEOUT_MS = 90_000;
const HANDLE_TRANSCRIPT_TIMEOUT_MS = 60_000;
const PHASE_HEARTBEAT_INTERVAL_MS = 5_000;

export const DictationSideEffects = () => {
  const intl = useIntl();

  const strategyRef = useRef<BaseStrategy | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const preDictationVolumeRef = useRef<number | null>(null);
  const recordingWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cancelPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isStoppingRef = useRef(false);
  const isPausedRef = useRef(false);
  // Last phase actually sent to the pill; drives the idle-reconciliation
  // heartbeat and keeps duplicate idle writes out of the pipe.
  const lastPhaseSentRef = useRef<OverlayPhase | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const isManualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );
  const isActiveSession = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const activeRecordingMode = useAppStore((state) => state.activeRecordingMode);
  const assistantInputMode = useAppStore((state) => state.assistantInputMode);
  const additionalLanguageEntries = useAppStore(getAdditionalLanguageEntries);
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

  const clearRecordingTimers = useCallback(() => {
    if (recordingWarningTimerRef.current) {
      clearTimeout(recordingWarningTimerRef.current);
      recordingWarningTimerRef.current = null;
    }
    if (recordingAutoStopTimerRef.current) {
      clearTimeout(recordingAutoStopTimerRef.current);
      recordingAutoStopTimerRef.current = null;
    }
  }, []);

  const clearCancelPromptTimer = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearTimeout(cancelPromptTimerRef.current);
      cancelPromptTimerRef.current = null;
    }
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
      hardResetHotkeyState,
      restoreSystemVolume,
      sendPhaseToPill,
      intl,
    ],
  );

  const stopRecordingRaw = useCallback(async (): Promise<RawStopResp> => {
    getLogger().info("Stopping recording");
    clearRecordingTimers();
    restoreSystemVolume();

    try {
      const [audio, a11yInfo, appTarget] = await getLogger().stopwatch(
        "stopRecording",
        async () => {
          let audio: StopRecordingResponse | null = null;
          let a11yInfo: TextFieldInfo | null = null;
          let appTarget: AppTarget | null = null;
          try {
            tryPlayAudioChime("stop_recording_clip");

            getLogger().verbose(
              "Invoking stop_recording and fetching a11y info",
            );
            const [, outAudio, outA11yInfo, outAppTarget] = await Promise.all([
              strategyRef.current?.setPhase("loading"),
              invoke<StopRecordingResponse>("stop_recording"),
              invoke<TextFieldInfo>("get_text_field_info").catch((error) => {
                getLogger().verbose(`Failed to get text field info: ${error}`);
                return null;
              }),
              tryRegisterCurrentAppTarget().catch((error) => {
                getLogger().verbose(
                  `Failed to get current app target: ${error}`,
                );
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

      if (!audio) {
        getLogger().warning("stopRecordingRaw: no audio data received");
        return {
          shouldContinue: false,
          abortMessage: "No audio data received",
        };
      }

      getLogger().info("Finalizing transcription session");
      trackAppUsed(appTarget?.name ?? "Unknown");

      if (appTarget) {
        saveManualStyleForApp(appTarget);
      }

      const toneId = getToneIdToUse(getAppState(), {
        currentAppToneId: appTarget?.toneId ?? null,
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
      if (!rawTranscript) {
        const strategyForEmpty = strategyRef.current;
        if (!strategyForEmpty) {
          getLogger().warning(
            "stopRecordingRaw: refs cleared before empty-result handling",
          );
          return {
            shouldContinue: false,
          };
        }
        const { handled } = await handleEmptyTranscriptionResult({
          audio,
          transcribeResult,
          strategy: strategyForEmpty,
          formatMessage: intl.formatMessage,
          showToast,
          storeTranscriptionFn: storeTranscription,
          // emitFailed previously forwarded a synthetic "recording_failed"
          // event here, but the global listener in this component then
          // surfaced a *second* error toast on top of the one the
          // empty-transcript handler already shows. Single toast owner is
          // the empty-transcript path now; no cross-event propagation.
          emitFailed: () => {},
          refreshMember,
        });
        if (handled) {
          return {
            shouldContinue: false,
          };
        }
        getLogger().warning("stopRecordingRaw: no rawTranscript from finalize");
        return {
          shouldContinue: false,
        };
      }

      const session = sessionRef.current;
      const strategy = strategyRef.current;
      if (!session || !strategy) {
        getLogger().warning(
          `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
        );
        return {
          shouldContinue: false,
        };
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
    } catch (error) {
      const errorName = error instanceof Error ? ` [name=${error.name}]` : "";
      getLogger().error(`Error during stopRecording: ${error}${errorName}`);
      return {
        shouldContinue: false,
        abortMessage: String(error),
      };
    } finally {
      // Phase convergence: every stop path (success, error, watchdog
      // timeout) must return the pill to idle.
      await sendPhaseToPill("idle");
    }
  }, [restoreSystemVolume, sendPhaseToPill]);

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
    }
  }, [
    abortRecording,
    clearRecordingTimers,
    hardResetHotkeyState,
    stopRecordingRaw,
    setIsStopping,
  ]);

  const startRecordingTimers = useCallback(() => {
    clearRecordingTimers();

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
  }, [stopRecording, intl, clearRecordingTimers]);

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
        loadManualStyleForCurrentApp();
      }

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
          }),
        ]);

        const sampleRate = startRecordingResult.sampleRate;
        getLogger().verbose(`Recording started (sampleRate=${sampleRate})`);

        // A stop/abort can arrive while `start_recording` is still opening
        // the mic (WASAPI init can take >1s on loaded machines).
        // `abortRecording` nulls the refs, so re-check against a snapshot
        // taken after the await — reading `sessionRef.current` here is what
        // threw "Cannot read properties of null (reading 'onRecordingStart')"
        // when the user stopped mid-initialization.
        const startedSession = sessionRef.current;
        const startedStrategy = strategyRef.current;
        if (!startedSession || !startedStrategy) {
          getLogger().warning(
            "Recording start raced an abort; skipping session start (abort already ran cleanup)",
          );
          return;
        }

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

        startRecordingTimers();
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

        // The `recording_failed` global listener (registered below) is the
        // single owner of the user-visible failure toast. The Rust
        // `start_recording` already emitted that event before rejecting
        // here, so this catch only does state cleanup. Adding a toast in
        // this block stacks a second "Recording failed" notification over
        // the listener's platform-specific one.
      }
    },
    [
      abortRecording,
      clearRecordingState,
      clearRecordingTimers,
      dimSystemVolume,
      hardResetHotkeyState,
      intl,
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
    () => switchWritingStyleForward(),
    [],
  );

  const handleSwitchWritingStyleBackward = useCallback(
    () => switchWritingStyleBackward(),
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

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling,
    onFire: handleSwitchWritingStyleForward,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling,
    onFire: handleSwitchWritingStyleBackward,
  });

  useHotkeyHold({
    actionName: DICTATE_HOTKEY,
    isDisabled: !isDictationInteractable || activeRecordingMode === "agent",
    controller: dictationController,
  });

  useHotkeyHold({
    actionName: AGENT_DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      !assistantModeEnabled ||
      activeRecordingMode === "dictate",
    controller: agentController,
  });

  useHotkeyFire({
    actionName: CANCEL_TRANSCRIPTION_HOTKEY,
    isDisabled: !isActiveSession,
    onFire: promptCancelTranscription,
  });

  useHotkeyHoldMany({
    isDisabled: !isDictationInteractable || activeRecordingMode === "agent",
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
    await abortRecording();
  });

  useTauriListen<void>("assistant-enable-type-mode", async () => {
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

    produceAppState((draft) => {
      draft.assistantInputMode = "type";
    });
  });

  useTauriListen<{ text: string }>(
    "assistant-typed-message",
    async (payload) => {
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
    (payload) => openPillConversation(payload.conversationId),
  );

  useHotkeyFire({
    actionName: OPEN_CHAT_HOTKEY,
    isDisabled: !isActiveSession,
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
      clearRecordingTimers();
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
  }, [clearRecordingTimers, intl]);

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
      startRecordingTimers();
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
  }, [intl, startRecordingTimers]);

  useTauriListen<void>("cancel-dictation", () => {
    abortRecording();
  });

  useTauriListen<void>("pause-dictation", () => {
    void pauseDictation();
  });

  useTauriListen<void>("resume-dictation", () => {
    void resumeDictation();
  });

  // The Windows global hotkey hook installed by `rdev::grab` is torn down
  // across a sleep/wake boundary or a workstation unlock. The native
  // lifecycle watcher (see `platform/windows/lifecycle.rs`) emits this
  // event in response to either transition; re-invoking
  // `restart_key_listener` causes the platform-agnostic `start_key_listener`
  // path to stop the dead child process and spawn a fresh one, which
  // re-installs the low-level hook. The TS listener is fire-and-forget:
  // the Rust side already serializes concurrent stop/start calls, so a
  // second event arriving while the restart is in flight just becomes a
  // second no-op idempotent restart.
  useTauriListen<void>("desktop_resume", () => {
    invoke("restart_key_listener").catch((error) =>
      getLogger().error(
        `Failed to restart key listener after resume: ${error}`,
      ),
    );
  });

  useTauriListen<string>("recording_failed", (message) => {
    // Backend `start_recording` emits this event when the mic cannot be
    // initialised (no device, permission denied, WASAPI failure). The
    // invoke-rejection already surfaces a generic toast, but the event
    // payload carries a more specific reason from the platform layer.
    getLogger().error(`Recording failed (backend): ${message}`);
    showToast({
      message:
        message && message.trim().length > 0
          ? `${intl.formatMessage({ defaultMessage: "Recording failed" })}: ${message}`
          : intl.formatMessage({ defaultMessage: "Recording failed" }),
      toastType: "error",
      duration: 8_000,
    });
  });

  useToastAction(async (payload) => {
    if (payload.action === "confirm_cancel_transcription") {
      await abortRecording();
    }
  });

  useTauriListen<void>("on-click-dictate", () => {
    if (isDictationInteractable) {
      debouncedToggle("dictation", dictationController);
    }
  });

  useTauriListen<void>("on-click-agent-talk", () => {
    if (isDictationInteractable) {
      debouncedToggle("agent", agentController);
    }
  });

  useTauriListen<void>("tone-switch-forward", () => {
    switchWritingStyleForward();
  });

  useTauriListen<void>("tone-switch-backward", () => {
    switchWritingStyleBackward();
  });

  useTauriListen<OverlayResolvePermissionPayload>(
    "overlay-resolve-permission",
    (payload) => {
      if (payload.alwaysAllow) {
        const permission =
          getAppState().toolPermissionById[payload.permissionId];
        if (permission) {
          setToolAlwaysAllow({
            toolId: permission.toolId,
            params: permission.params,
            allowed: true,
          });
        }
      }
      resolveToolPermission(payload.permissionId, payload.status);
    },
  );

  useEffect(() => {
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
    invoke("notify_pill_style_info", {
      count: pillStyleCount,
      name: pillStyleName,
    }).catch(console.error);
  }, [pillStyleCount, pillStyleName]);

  return null;
};
