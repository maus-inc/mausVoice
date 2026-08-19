import { convertFloat32ToPCM16 } from "@maus-inc/voice-ai";
import { getLogger } from "../utils/log.utils";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  computeChunkBounds,
  createAudioBufferController,
  createSessionTextBuffer,
  createChunkSender,
} from "./streaming-audio-buffer";

type AssemblyAIStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
};

const startAssemblyAIStreaming = async (
  apiKey: string,
  sampleRate: number,
  onInterimResult?: (segment: string) => void,
): Promise<AssemblyAIStreamingSession> => {
  getLogger().info(
    "[AssemblyAI WebSocket] Starting with sample rate:",
    sampleRate,
  );
  const { minSamplesPerChunk, maxSamplesPerChunk } = computeChunkBounds(
    sampleRate,
    50,
    100,
  );
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let unlisten: UnlistenFn | null = null;
    let finalTranscript = "";
    let isFinalized = false;
    let receivedChunkCount = 0;
    let sentChunkCount = 0;
    const audioBuffer = createAudioBufferController();

    let currentTurn = 0;
    let extra = "";

    const { getText, resetBuffers, drainSamples } = createSessionTextBuffer(
      () => finalTranscript,
      () => extra,
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
          getLogger().info(
            `[AssemblyAI WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${payload.byteLength} bytes)`,
          );
        }
      },
      onSendError: (error) => {
        getLogger().error(
          "[AssemblyAI WebSocket] Error sending buffered chunk:",
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

    const finalize = (): Promise<string> => {
      let resolveFinalizeRef: ((text: string) => void) | null = null;
      let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;
      let originalOnCloseRef:
        ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

      const handleTerminateTimeout = () => {
        getLogger().info(
          "[AssemblyAI WebSocket] Timeout reached, finalizing with transcript length:",
          getText().length,
        );
        cleanup();
        resolveFinalizeRef?.(getText());
      };

      const handleSocketCloseAfterTerminate = () => {
        if (finalizeTimeout) {
          clearTimeout(finalizeTimeout);
          finalizeTimeout = null;
        }
        const socket = ws;
        if (originalOnCloseRef && socket) {
          originalOnCloseRef.call(socket, {} as CloseEvent);
        }
        cleanup();
        getLogger().info(
          "[AssemblyAI WebSocket] WebSocket closed, finalizing with transcript length:",
          getText().length,
        );
        resolveFinalizeRef?.(getText());
      };

      return new Promise((resolveFinalize) => {
        getLogger().info(
          "[AssemblyAI WebSocket] Finalize called, isFinalized:",
          isFinalized,
          "ws state:",
          ws?.readyState,
        );
        if (isFinalized) {
          getLogger().info(
            "[AssemblyAI WebSocket] Already finalized, returning transcript",
          );
          resolveFinalize(getText());
          return;
        }

        isFinalized = true;
        flushPendingSamples(true);
        getLogger().info(
          "[AssemblyAI WebSocket] Total chunks sent:",
          sentChunkCount,
        );

        if (ws?.readyState === WebSocket.OPEN) {
          getLogger().info(
            "[AssemblyAI WebSocket] Sending Terminate message...",
          );
          // Send termination message, then wait a bit for the final transcript
          ws.send(JSON.stringify({ type: "Terminate" }));
          resolveFinalizeRef = resolveFinalize;
          originalOnCloseRef = ws.onclose;
          finalizeTimeout = setTimeout(handleTerminateTimeout, 2000);
          ws.onclose = handleSocketCloseAfterTerminate;
        } else {
          cleanup();
          resolveFinalize(finalTranscript);
        }
      });
    };

    // Open WebSocket
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${sampleRate}&token=${apiKey}`;
    getLogger().info(
      "[AssemblyAI WebSocket] Connecting (api key present:",
      Boolean(apiKey),
      "length:",
      apiKey?.length ?? 0,
      ")",
    );
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      getLogger().info("[AssemblyAI WebSocket] Connected, sending auth...");
      // Auth is carried by the token query parameter in wsUrl; the first
      // message sent over the socket is audio data, not credentials.

      // Listen for audio chunks from Rust
      try {
        getLogger().info(
          "[AssemblyAI WebSocket] Setting up audio_chunk listener...",
        );
        unlisten = await listen<{ samples: number[] }>(
          "audio_chunk",
          (event) => {
            receivedChunkCount++;
            if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
              getLogger().info(
                `[AssemblyAI WebSocket] Received chunk #${receivedChunkCount}, samples:`,
                event.payload.samples.length,
              );
            }
            if (ws?.readyState === WebSocket.OPEN && !isFinalized) {
              try {
                const typedChunk =
                  event.payload.samples instanceof Float32Array
                    ? event.payload.samples
                    : Float32Array.from(event.payload.samples);
                audioBuffer.pushSamples(typedChunk);
                flushPendingSamples(false);
              } catch (error) {
                getLogger().error(
                  "[AssemblyAI WebSocket] Error sending audio chunk:",
                  error,
                );
              }
            }
          },
        );

        getLogger().info(
          "[AssemblyAI WebSocket] Session ready, listener attached",
        );
        // Session is ready
        resolve({ finalize, cleanup });
      } catch (error) {
        getLogger().error(
          "[AssemblyAI WebSocket] Error setting up listener:",
          error,
        );
        cleanup();
        reject(error);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Turn messages carry the user's transcript; log metadata only.
        getLogger().info("[AssemblyAI WebSocket] Received message", {
          type: data.type,
          turnOrder: data.turn_order,
          endOfTurn: data.end_of_turn,
          transcriptLength:
            typeof data.transcript === "string" ? data.transcript.length : 0,
        });

        if (data.type === "Turn" && data.end_of_turn) {
          // Final formatted transcript
          const turnTranscript = data.transcript || "";
          finalTranscript += (finalTranscript ? " " : "") + turnTranscript;
          getLogger().info(
            "[AssemblyAI WebSocket] Final formatted transcript received, length:",
            finalTranscript.length,
          );
          if (onInterimResult && turnTranscript) {
            onInterimResult(turnTranscript);
          }
          if (currentTurn === data.turn_order) {
            extra = "";
          }
        } else if (data.type === "Turn") {
          if (currentTurn != data.turn_order) {
            currentTurn = data.turn_order;

            extra = data.transcript;
          }
        }
      } catch (error) {
        getLogger().error(
          "[AssemblyAI WebSocket] Error parsing message:",
          error,
        );
      }
    };

    ws.onerror = (error) => {
      getLogger().error("[AssemblyAI WebSocket] WebSocket error:", error);
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = (event) => {
      getLogger().info("[AssemblyAI WebSocket] WebSocket closed:", {
        code: event.code,
        reason: event.reason,
      });
      cleanup();
    };
  });
};

export class AssemblyAITranscriptionSession implements TranscriptionSession {
  private session: AssemblyAIStreamingSession | null = null;
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
    try {
      getLogger().info("[AssemblyAI] Starting streaming session...");
      this.session = await startAssemblyAIStreaming(
        this.apiKey,
        sampleRate,
        this.interimCallback ?? undefined,
      );
      getLogger().info("[AssemblyAI] Streaming session started successfully");
    } catch (error) {
      getLogger().error("[AssemblyAI] Failed to start streaming:", error);
      // Continue recording anyway - finalize will handle missing session
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • AssemblyAI (Streaming)",
          transcriptionMode: "api",
        },
        warnings: ["AssemblyAI streaming session was not established"],
      };
    }

    try {
      getLogger().info("[AssemblyAI] Finalizing streaming session...");
      const finalizeStart = performance.now();
      const transcript = await this.session.finalize();
      const durationMs = Math.round(performance.now() - finalizeStart);

      getLogger().info("[AssemblyAI] Transcript timing:", { durationMs });
      getLogger().info(
        "[AssemblyAI] Received transcript, length:",
        transcript?.length ?? 0,
      );

      return {
        rawTranscript: transcript || null,
        metadata: {
          inferenceDevice: "API • AssemblyAI (Streaming)",
          transcriptionMode: "api",
          transcriptionDurationMs: durationMs,
        },
        warnings: [],
      };
    } catch (error) {
      getLogger().error("[AssemblyAI] Failed to finalize session:", error);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • AssemblyAI (Streaming)",
          transcriptionMode: "api",
        },
        warnings: [
          `AssemblyAI finalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
