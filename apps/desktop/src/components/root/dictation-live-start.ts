import type { RefObject } from "react";
import { getLogger } from "../../utils/log.utils";
import { startLiveProviderSession } from "../../sessions/provider-startup.utils";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import type { TranscriptionSessionKind } from "../../sessions";

export type PendingProviderStartup = {
  operationId: number;
  promise: Promise<void>;
};

export type LiveProviderStartContext = {
  operationId: number;
  session: TranscriptionSession;
  sampleRate: number;
  controller: AbortController;
  isCurrentStart: () => boolean;
  cleanupStartedSession: () => void;
  replayStartupAudio: () => void;
  onStartupAudioDiscarded: () => void;
  isStopping: () => boolean;
  sendPillStageText: (text: string | null) => void;
  stopRecording: () => unknown;
  providerStartupRef: RefObject<PendingProviderStartup | null>;
  providerStartupAbortControllerRef: RefObject<AbortController | null>;
};

/**
 * The live-provider leg of a recording start. The session is already
 * registered on the row, so every exit path either replays the buffered
 * startup audio or preserves what was captured and stops the recording.
 */
export const startLiveProviderRecording = (ctx: LiveProviderStartContext) => {
  const {
    operationId,
    session,
    sampleRate,
    controller,
    isCurrentStart,
    cleanupStartedSession,
    replayStartupAudio,
    onStartupAudioDiscarded,
    isStopping,
    sendPillStageText,
    stopRecording,
    providerStartupRef,
    providerStartupAbortControllerRef,
  } = ctx;

  return (async () => {
    try {
      await startLiveProviderSession({ session, sampleRate, controller });
      if (!isCurrentStart()) {
        cleanupStartedSession();
        return;
      }
      replayStartupAudio();
      if (!isStopping()) {
        sendPillStageText(null);
      }
    } catch (error) {
      if (!isCurrentStart()) {
        cleanupStartedSession();
        return;
      }
      getLogger().warning(
        `Live provider startup failed; preserving the captured recording: ${error}`,
      );
      cleanupStartedSession();
      onStartupAudioDiscarded();
      if (!isStopping()) {
        sendPillStageText(null);
        void stopRecording();
      }
    } finally {
      if (providerStartupRef.current?.operationId === operationId) {
        providerStartupRef.current = null;
      }
      if (providerStartupAbortControllerRef.current === controller) {
        providerStartupAbortControllerRef.current = null;
      }
    }
  })();
};

/**
 * A live session already received this segment over its own socket, so a
 * discontinuous capture must not replay it as an interim result.
 */
export const shouldForwardInterimSegment = (
  sessionKind: TranscriptionSessionKind,
  hasDiscontinuity: boolean,
): boolean => sessionKind !== "live-streaming" || !hasDiscontinuity;
