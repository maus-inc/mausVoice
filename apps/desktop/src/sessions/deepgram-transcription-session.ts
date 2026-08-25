import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { getLogger } from "../utils/log.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import {
  createAudioChunkBuffer,
  createReceivedChunkLogger,
} from "./transcription-stream.utils";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";

type DeepgramStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
};

const LOGGER_PREFIX = "Deepgram WebSocket";

const startDeepgramStreaming = async (
  apiKey: string,
  sampleRate: number,
  language: string,
  onInterimResult?: (segment: string) => void,
): Promise<DeepgramStreamingSession> => {
  getLogger().verbose(
    `[${LOGGER_PREFIX}] Starting with sample rate:`,
    sampleRate,
  );

  let ws: WebSocket | null = null;
  let unlisten: UnlistenFn | null = null;
  let isFinalized = false;
  const transcriptState = createTranscriptAccumulator();
  const receivedLogger = createReceivedChunkLogger(LOGGER_PREFIX);

  const buffer = createAudioChunkBuffer(() => ws, {
    sampleRate,
    minChunkDurationMs: 20,
    maxChunkDurationMs: 100,
    loggerPrefix: LOGGER_PREFIX,
  });

  const getText = () => transcriptState.text();

  const cleanup = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      ws = null;
    }
    buffer.reset();
  };

  let finalizeResolver: ((text: string) => void) | null = null;
  let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  const finalize = (): Promise<string> => {
    return new Promise((resolveFinalize) => {
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Finalize called, isFinalized:`,
        isFinalized,
        "ws state:",
        ws?.readyState,
      );
      if (isFinalized) {
        getLogger().verbose(
          `[${LOGGER_PREFIX}] Already finalized, returning transcript`,
        );
        resolveFinalize(getText());
        return;
      }

      isFinalized = true;
      finalizeResolver = resolveFinalize;
      buffer.flush(true);
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Total chunks sent:`,
        buffer.sentChunkCount(),
      );

      if (ws && ws.readyState === WebSocket.OPEN) {
        getLogger().verbose(
          `[${LOGGER_PREFIX}] Sending CloseStream message...`,
        );
        ws.send(JSON.stringify({ type: "CloseStream" }));

        finalizeTimeout = setTimeout(() => {
          getLogger().verbose(
            `[${LOGGER_PREFIX}] Timeout reached, finalizing with transcript length:`,
            getText().length,
          );
          cleanup();
          if (finalizeResolver) {
            finalizeResolver(getText());
            finalizeResolver = null;
          }
        }, 3000);
      } else {
        cleanup();
        resolveFinalize(getText());
      }
    });
  };

  const completeFinalize = () => {
    if (finalizeTimeout) {
      clearTimeout(finalizeTimeout);
      finalizeTimeout = null;
    }
    if (finalizeResolver) {
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Completing finalize with transcript length:`,
        getText().length,
      );
      cleanup();
      finalizeResolver(getText());
      finalizeResolver = null;
    }
  };

  getLogger().verbose(`[${LOGGER_PREFIX}] Setting up audio_chunk listener...`);
  unlisten = await listen<{ samples: number[] }>("audio_chunk", (event) => {
    receivedLogger.record(event.payload.samples.length);
    if (!isFinalized) {
      try {
        const typedChunk =
          event.payload.samples instanceof Float32Array
            ? event.payload.samples
            : Float32Array.from(event.payload.samples);
        buffer.push(typedChunk);
        buffer.flush(false);
      } catch (error) {
        getLogger().error(
          `[${LOGGER_PREFIX}] Error sending audio chunk:`,
          error,
        );
      }
    }
  });
  getLogger().verbose(
    `[${LOGGER_PREFIX}] Audio listener attached, connecting...`,
  );

  return new Promise((resolve, reject) => {
    const wsUrl = buildDeepgramWebSocketUrl({
      sampleRate,
      language,
    });
    getLogger().verbose(`[${LOGGER_PREFIX}] Connecting to:`, wsUrl);
    ws = new WebSocket(wsUrl, ["token", apiKey]);

    ws.onopen = () => {
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Connected, flushing buffered audio...`,
      );
      buffer.flush(false);
      getLogger().verbose(`[${LOGGER_PREFIX}] Session ready`);
      resolve({ finalize, cleanup });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const messageType = data.type;
        getLogger().verbose(
          `[${LOGGER_PREFIX}] Received message:`,
          messageType,
          data,
        );

        if (messageType === "Results") {
          const transcriptText =
            data.channel?.alternatives?.[0]?.transcript || "";
          const isFinal = data.is_final === true;
          const speechFinal = data.speech_final === true;

          if (isFinal && transcriptText) {
            transcriptState.appendFinal(transcriptText);
            transcriptState.setPartial("");
            getLogger().verbose(
              `[${LOGGER_PREFIX}] Final transcript received, length:`,
              transcriptState.finalLength(),
            );
            if (onInterimResult) {
              onInterimResult(transcriptText);
            }
            if (speechFinal && isFinalized) {
              completeFinalize();
            }
          } else if (!isFinal && transcriptText) {
            transcriptState.setPartial(transcriptText);
          }
        } else if (messageType === "Metadata") {
          getLogger().verbose(`[${LOGGER_PREFIX}] Metadata received:`, data);
        } else if (messageType === "Error" || data.error) {
          getLogger().error(`[${LOGGER_PREFIX}] Error from server:`, data);
        }
      } catch (error) {
        getLogger().error(`[${LOGGER_PREFIX}] Error parsing message:`, error);
      }
    };

    ws.onerror = (error) => {
      getLogger().error(`[${LOGGER_PREFIX}] WebSocket error:`, error);
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = (event) => {
      getLogger().verbose(`[${LOGGER_PREFIX}] WebSocket closed:`, {
        code: event.code,
        reason: event.reason,
      });
      if (isFinalized && finalizeResolver) {
        completeFinalize();
      }
      cleanup();
    };
  });
};

export class DeepgramTranscriptionSession implements TranscriptionSession {
  private session: DeepgramStreamingSession | null = null;
  private startupPromise: Promise<void> | null = null;
  private apiKey: string;
  private interimCallback: ((segment: string) => void) | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: (segment: string) => void): void {
    this.interimCallback = callback;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);

        getLogger().verbose("[Deepgram] Starting streaming session...");
        this.session = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          this.interimCallback ?? undefined,
        );
        getLogger().verbose(
          "[Deepgram] Streaming session started successfully",
        );
      } catch (error) {
        getLogger().error("[Deepgram] Failed to start streaming:", error);
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (this.startupPromise) {
      await this.startupPromise;
    }

    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • Deepgram (Streaming)",
          transcriptionMode: "api",
        },
        warnings: ["Deepgram streaming session was not established"],
      };
    }

    try {
      getLogger().verbose("[Deepgram] Finalizing streaming session...");
      const finalizeStart = performance.now();
      const transcript = await this.session.finalize();
      const durationMs = Math.round(performance.now() - finalizeStart);

      getLogger().verbose("[Deepgram] Transcript timing:", { durationMs });
      getLogger().verbose(
        "[Deepgram] Received transcript, length:",
        transcript?.length ?? 0,
      );

      return {
        rawTranscript: transcript || null,
        metadata: {
          inferenceDevice: "API • Deepgram (Streaming)",
          transcriptionMode: "api",
          transcriptionDurationMs: durationMs,
        },
        warnings: [],
      };
    } catch (error) {
      getLogger().error("[Deepgram] Failed to finalize session:", error);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • Deepgram (Streaming)",
          transcriptionMode: "api",
        },
        warnings: [
          `Deepgram finalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
      };
    }
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
  }
}
