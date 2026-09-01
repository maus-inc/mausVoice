import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
<<<<<<< HEAD
=======
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  combineStreamingTranscript,
  createAudioChunkPump,
} from "../utils/audio-chunking.utils";
import {
  createStreamingFinalize,
  finalizeStreamingSession,
} from "../utils/streaming-session.utils";
>>>>>>> origin/fix/superfix-review-findings
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { getLogger } from "../utils/log.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import {
  createAudioChunkBuffer,
  createReceivedChunkLogger,
} from "./transcription-stream.utils";

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
<<<<<<< HEAD
  getLogger().verbose(
    `[${LOGGER_PREFIX}] Starting with sample rate:`,
    sampleRate,
  );
=======
  console.log("[Deepgram WebSocket] Starting with sample rate:", sampleRate);
>>>>>>> origin/fix/superfix-review-findings

  let ws: WebSocket | null = null;
  let unlisten: UnlistenFn | null = null;
  let isFinalized = false;
<<<<<<< HEAD
  const transcriptState = createTranscriptAccumulator();
  const receivedLogger = createReceivedChunkLogger(LOGGER_PREFIX);

  const buffer = createAudioChunkBuffer(() => ws, {
    sampleRate,
    minChunkDurationMs: 20,
    maxChunkDurationMs: 100,
    loggerPrefix: LOGGER_PREFIX,
  });

  const getText = () => transcriptState.text();
=======
  let receivedChunkCount = 0;
  let sentChunkCount = 0;

  const pump = createAudioChunkPump({
    sampleRate,
    minChunkDurationMs: 20,
    maxChunkDurationMs: 100,
    canSend: () => !!ws && ws.readyState === WebSocket.OPEN,
    sendChunk: (chunk) => {
      const pcm16 = convertFloat32ToPCM16(chunk);
      ws?.send(pcm16);
      sentChunkCount++;
      if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
        const durationMs = (chunk.length / sampleRate) * 1000;
        console.log(
          `[Deepgram WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${pcm16.byteLength} bytes)`,
        );
      }
    },
    onError: (error) => {
      console.error(
        "[Deepgram WebSocket] Error sending buffered chunk:",
        error,
      );
    },
  });

  const getText = () =>
    combineStreamingTranscript(finalTranscript, partialTranscript);
>>>>>>> origin/fix/superfix-review-findings

  const cleanup = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      ws = null;
    }
<<<<<<< HEAD
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
=======
    pump.resetBuffers();
  };

  const streamingFinalize = createStreamingFinalize({
    logPrefix: "[Deepgram WebSocket]",
    timeoutMs: 3000,
    getText,
    getIsFinalized: () => isFinalized,
    setIsFinalized: (value) => {
      isFinalized = value;
    },
    flushPendingSamples: (force) => pump.flushPendingSamples(force),
    logTotalChunks: () =>
      console.log("[Deepgram WebSocket] Total chunks sent:", sentChunkCount),
    canSend: () => !!ws && ws.readyState === WebSocket.OPEN,
    getWsState: () => ws?.readyState,
    sendTermination: () => ws?.send(JSON.stringify({ type: "CloseStream" })),
    cleanup,
  });
  const { finalize, completeFinalize } = streamingFinalize;
>>>>>>> origin/fix/superfix-review-findings

  getLogger().verbose(`[${LOGGER_PREFIX}] Setting up audio_chunk listener...`);
  unlisten = await listen<{ samples: number[] }>("audio_chunk", (event) => {
    receivedLogger.record(event.payload.samples.length);
    if (!isFinalized) {
      try {
        const typedChunk =
          event.payload.samples instanceof Float32Array
            ? event.payload.samples
            : Float32Array.from(event.payload.samples);
<<<<<<< HEAD
        buffer.push(typedChunk);
        buffer.flush(false);
=======
        pump.pushSamples(typedChunk);
        pump.flushPendingSamples();
>>>>>>> origin/fix/superfix-review-findings
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
<<<<<<< HEAD
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Connected, flushing buffered audio...`,
      );
      buffer.flush(false);
      getLogger().verbose(`[${LOGGER_PREFIX}] Session ready`);
=======
      console.log("[Deepgram WebSocket] Connected, flushing buffered audio...");
      pump.flushPendingSamples();
      console.log("[Deepgram WebSocket] Session ready");
>>>>>>> origin/fix/superfix-review-findings
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
      if (isFinalized && streamingFinalize.hasPendingFinalize()) {
        completeFinalize();
      }
      cleanup();
    };
  });
};

export class DeepgramTranscriptionSession extends BaseApiTranscriptionSession {
  private startupPromise: Promise<void> | null = null;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super({
      providerLabel: "Deepgram",
      inferenceDevice: "API • Deepgram (Streaming)",
    });
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);

        getLogger().verbose("[Deepgram] Starting streaming session...");
        this.streamSession = await startDeepgramStreaming(
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
    audio: Parameters<BaseApiTranscriptionSession["finalize"]>[0],
  ) {
    if (this.startupPromise) {
      await this.startupPromise;
    }
<<<<<<< HEAD
    return super.finalize(audio);
=======

    return finalizeStreamingSession({
      session: this.session,
      providerLabel: "Deepgram",
      log: console.log,
    });
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
>>>>>>> origin/fix/superfix-review-findings
  }
}
