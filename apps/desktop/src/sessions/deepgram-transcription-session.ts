import { convertFloat32ToPCM16 } from "@maus-inc/voice-ai";
import {
  computeChunkBounds,
  createAudioBufferController,
  createSessionTextBuffer,
  createChunkSender,
} from "./streaming-audio-buffer";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";

type DeepgramStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
};

const startDeepgramStreaming = async (
  apiKey: string,
  sampleRate: number,
  language: string,
  onInterimResult?: (segment: string) => void,
): Promise<DeepgramStreamingSession> => {
  console.log("[Deepgram WebSocket] Starting with sample rate:", sampleRate);
  const { minSamplesPerChunk, maxSamplesPerChunk } = computeChunkBounds(
    sampleRate,
    20,
    100,
  );

  let ws: WebSocket | null = null;
  let unlisten: UnlistenFn | null = null;
  let finalTranscript = "";
  let partialTranscript = "";
  let isFinalized = false;
  let receivedChunkCount = 0;
  let sentChunkCount = 0;
  const audioBuffer = createAudioBufferController();

  const { getText, resetBuffers, drainSamples } = createSessionTextBuffer(
    () => finalTranscript,
    () => partialTranscript,
    audioBuffer,
  );

  const chunkSender = createChunkSender({
    ws: () => ws,
    drainSamples,
    getPendingSampleCount: () => audioBuffer.getPendingSampleCount(),
    minSamplesPerChunk,
    maxSamplesPerChunk,
    sampleRate,
    convertToPayload: convertFloat32ToPCM16,
    onChunkSent: (chunk, payload) => {
      sentChunkCount++;
      if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
        const durationMs = (chunk.length / sampleRate) * 1000;
        console.log(
          `[Deepgram WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${payload.byteLength} bytes)`,
        );
      }
    },
    onSendError: (error) => {
      console.error(
        "[Deepgram WebSocket] Error sending buffered chunk:",
        error,
      );
    },
  });

  const { flushPendingSamples } = chunkSender;

  const cleanup = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      ws = null;
    }
    resetBuffers();
  };

  let finalizeResolver: ((text: string) => void) | null = null;
  let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  const finalize = (): Promise<string> => {
    return new Promise((resolveFinalize) => {
      console.log(
        "[Deepgram WebSocket] Finalize called, isFinalized:",
        isFinalized,
        "ws state:",
        ws?.readyState,
      );
      if (isFinalized) {
        console.log(
          "[Deepgram WebSocket] Already finalized, returning transcript",
        );
        resolveFinalize(getText());
        return;
      }

      isFinalized = true;
      finalizeResolver = resolveFinalize;
      flushPendingSamples(true);
      console.log("[Deepgram WebSocket] Total chunks sent:", sentChunkCount);

      if (ws?.readyState === WebSocket.OPEN) {
        console.log("[Deepgram WebSocket] Sending CloseStream message...");
        ws.send(JSON.stringify({ type: "CloseStream" }));

        finalizeTimeout = setTimeout(() => {
          console.log(
            "[Deepgram WebSocket] Timeout reached, finalizing with transcript length:",
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
      console.log(
        "[Deepgram WebSocket] Completing finalize with transcript length:",
        getText().length,
      );
      cleanup();
      finalizeResolver(getText());
      finalizeResolver = null;
    }
  };

  // Start listening for audio chunks IMMEDIATELY, before the WebSocket connects.
  // This buffers audio so nothing is lost during the connection handshake.
  console.log("[Deepgram WebSocket] Setting up audio_chunk listener...");
  unlisten = await listen<{ samples: number[] }>("audio_chunk", (event) => {
    receivedChunkCount++;
    if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
      console.log(
        `[Deepgram WebSocket] Received chunk #${receivedChunkCount}, samples:`,
        event.payload.samples.length,
      );
    }
    if (!isFinalized) {
      try {
        const typedChunk =
          event.payload.samples instanceof Float32Array
            ? event.payload.samples
            : Float32Array.from(event.payload.samples);
        audioBuffer.pushSamples(typedChunk);
        flushPendingSamples(false);
      } catch (error) {
        console.error("[Deepgram WebSocket] Error sending audio chunk:", error);
      }
    }
  });
  console.log("[Deepgram WebSocket] Audio listener attached, connecting...");

  return new Promise((resolve, reject) => {
    const wsUrl = buildDeepgramWebSocketUrl({
      sampleRate,
      language,
    });
    console.log("[Deepgram WebSocket] Connecting to:", wsUrl);
    ws = new WebSocket(wsUrl, ["token", apiKey]);

    ws.onopen = () => {
      console.log("[Deepgram WebSocket] Connected, flushing buffered audio...");
      flushPendingSamples(false);
      console.log("[Deepgram WebSocket] Session ready");
      resolve({ finalize, cleanup });
    };

    const handleResultsMessage = (data: {
      channel?: { alternatives?: { transcript?: string }[] };
      is_final?: boolean;
      speech_final?: boolean;
    }) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = data.is_final === true;
      const speechFinal = data.speech_final === true;

      if (isFinal && transcript) {
        finalTranscript += (finalTranscript ? " " : "") + transcript;
        partialTranscript = "";
        console.log(
          "[Deepgram WebSocket] Final transcript received, length:",
          finalTranscript.length,
        );
        onInterimResult?.(transcript);
        if (speechFinal && isFinalized) {
          completeFinalize();
        }
      } else if (!isFinal && transcript) {
        partialTranscript = transcript;
      }
    };

    const handleServerMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const messageType = data.type;
        console.log(
          "[Deepgram WebSocket] Received message:",
          messageType,
          data,
        );

        if (messageType === "Results") {
          handleResultsMessage(data);
        } else if (messageType === "Metadata") {
          console.log("[Deepgram WebSocket] Metadata received:", data);
        } else if (messageType === "Error" || data.error) {
          console.error("[Deepgram WebSocket] Error from server:", data);
        }
      } catch (error) {
        console.error("[Deepgram WebSocket] Error parsing message:", error);
      }
    };

    ws.onmessage = handleServerMessage;

    ws.onerror = (error) => {
      console.error("[Deepgram WebSocket] WebSocket error:", error);
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = (event) => {
      console.log("[Deepgram WebSocket] WebSocket closed:", {
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
  private readonly apiKey: string;
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

        console.log("[Deepgram] Starting streaming session...");
        this.session = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          this.interimCallback ?? undefined,
        );
        console.log("[Deepgram] Streaming session started successfully");
      } catch (error) {
        console.error("[Deepgram] Failed to start streaming:", error);
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
      console.log("[Deepgram] Finalizing streaming session...");
      const finalizeStart = performance.now();
      const transcript = await this.session.finalize();
      const durationMs = Math.round(performance.now() - finalizeStart);

      console.log("[Deepgram] Transcript timing:", { durationMs });
      console.log(
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
      console.error("[Deepgram] Failed to finalize session:", error);
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
