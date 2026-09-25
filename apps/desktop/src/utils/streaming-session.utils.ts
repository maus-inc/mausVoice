import { TranscriptionSessionResult } from "../types/transcription-session.types";

export type StreamingFinalize = {
  finalize: () => Promise<string>;
  completeFinalize: () => void;
  hasPendingFinalize: () => boolean;
};

export type StreamingFinalizeOptions = {
  logPrefix: string;
  timeoutMs: number;
  getText: () => string;
  getIsFinalized: () => boolean;
  setIsFinalized: (value: boolean) => void;
  flushPendingSamples: (force: boolean) => void;
  logTotalChunks: () => void;
  canSend: () => boolean;
  getWsState: () => number | undefined;
  /** Optional wire-level termination signal (e.g. Deepgram's CloseStream). */
  sendTermination?: () => void;
  cleanup: () => void;
};

/**
 * Finalize protocol shared by the streaming sessions: flush the buffered
 * audio, optionally signal end-of-stream, then wait (bounded by `timeoutMs`)
 * for the provider's final transcript. `completeFinalize` is invoked by the
 * provider's message handler when the final transcript arrives early.
 */
export const createStreamingFinalize = ({
  logPrefix,
  timeoutMs,
  getText,
  getIsFinalized,
  setIsFinalized,
  flushPendingSamples,
  logTotalChunks,
  canSend,
  getWsState,
  sendTermination,
  cleanup,
}: StreamingFinalizeOptions): StreamingFinalize => {
  let finalizeResolver: ((text: string) => void) | null = null;
  let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  const finalize = (): Promise<string> =>
    new Promise((resolveFinalize) => {
      console.log(
        `${logPrefix} Finalize called, isFinalized:`,
        getIsFinalized(),
        "ws state:",
        getWsState(),
      );
      if (getIsFinalized()) {
        console.log(`${logPrefix} Already finalized, returning transcript`);
        resolveFinalize(getText());
        return;
      }

      setIsFinalized(true);
      finalizeResolver = resolveFinalize;
      flushPendingSamples(true);
      logTotalChunks();

      if (canSend()) {
        if (sendTermination) {
          console.log(`${logPrefix} Sending termination message...`);
          sendTermination();
        }
        finalizeTimeout = setTimeout(() => {
          console.log(
            `${logPrefix} Timeout reached, finalizing with transcript length:`,
            getText().length,
          );
          cleanup();
          if (finalizeResolver) {
            finalizeResolver(getText());
            finalizeResolver = null;
          }
        }, timeoutMs);
      } else {
        cleanup();
        finalizeResolver = null;
        resolveFinalize(getText());
      }
    });

  const completeFinalize = () => {
    if (finalizeTimeout) {
      clearTimeout(finalizeTimeout);
      finalizeTimeout = null;
    }
    if (finalizeResolver) {
      console.log(
        `${logPrefix} Completing finalize with transcript length:`,
        getText().length,
      );
      cleanup();
      finalizeResolver(getText());
      finalizeResolver = null;
    }
  };

  const hasPendingFinalize = () => finalizeResolver != null;

  return { finalize, completeFinalize, hasPendingFinalize };
};

/**
 * Result returned when the streaming session never got established, e.g. the
 * WebSocket failed before the session object was created.
 */
export const sessionMissingResult = (
  providerLabel: string,
): TranscriptionSessionResult => ({
  rawTranscript: null,
  metadata: {
    inferenceDevice: `API • ${providerLabel} (Streaming)`,
    transcriptionMode: "api",
  },
  warnings: [`${providerLabel} streaming session was not established`],
});

/**
 * Runs the provider session's finalize and wraps the outcome in the standard
 * `TranscriptionSessionResult` shape (metadata + warnings). Shared by the
 * streaming transcription session classes so their finalize bookkeeping stays
 * in one place.
 */
export const finalizeStreamingSession = async ({
  session,
  providerLabel,
  log,
  logError = console.error,
  getWarnings = () => [],
  modelSize,
}: {
  session: { finalize: () => Promise<string> } | null;
  providerLabel: string;
  log: typeof console.log;
  logError?: (message: string, ...args: unknown[]) => void;
  getWarnings?: () => string[];
  modelSize?: string;
}): Promise<TranscriptionSessionResult> => {
  if (!session) {
    return sessionMissingResult(providerLabel);
  }

  try {
    log(`[${providerLabel}] Finalizing streaming session...`);
    const finalizeStart = performance.now();
    const transcript = await session.finalize();
    const durationMs = Math.round(performance.now() - finalizeStart);

    log(`[${providerLabel}] Transcript timing:`, { durationMs });
    log(
      `[${providerLabel}] Received transcript, length:`,
      transcript?.length ?? 0,
    );

    return {
      rawTranscript: transcript || null,
      metadata: {
        inferenceDevice: `API • ${providerLabel} (Streaming)`,
        ...(modelSize !== undefined ? { modelSize } : {}),
        transcriptionMode: "api",
        transcriptionDurationMs: durationMs,
      },
      warnings: Array.from(new Set(getWarnings())),
    };
  } catch (error) {
    logError(`[${providerLabel}] Failed to finalize session:`, error);
    return {
      rawTranscript: null,
      metadata: {
        inferenceDevice: `API • ${providerLabel} (Streaming)`,
        ...(modelSize !== undefined ? { modelSize } : {}),
        transcriptionMode: "api",
      },
      warnings: Array.from(
        new Set([
          ...getWarnings(),
          `${providerLabel} finalization failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        ]),
      ),
    };
  }
};
