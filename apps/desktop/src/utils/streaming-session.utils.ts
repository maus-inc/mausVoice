import { TranscriptionSessionResult } from "../types/transcription-session.types";

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
}: {
  session: { finalize: () => Promise<string>; cleanup: () => void } | null;
  providerLabel: string;
  log: typeof console.log;
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
        transcriptionMode: "api",
        transcriptionDurationMs: durationMs,
      },
      warnings: [],
    };
  } catch (error) {
    log(`[${providerLabel}] Failed to finalize session:`, error);
    return {
      rawTranscript: null,
      metadata: {
        inferenceDevice: `API • ${providerLabel} (Streaming)`,
        transcriptionMode: "api",
      },
      warnings: [
        `${providerLabel} finalization failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      ],
    };
  }
};
