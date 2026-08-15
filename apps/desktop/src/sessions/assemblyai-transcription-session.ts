import { getLogger } from "../utils/log.utils";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { createAudioChunkPump } from "../utils/audio-chunking.utils";

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
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let unlisten: UnlistenFn | null = null;
    let finalTranscript = "";
    let isFinalized = false;
    let receivedChunkCount = 0;

    let currentTurn = 0;
    let extra = "";

    const pump = createAudioChunkPump({
      sampleRate,
      minChunkDurationMs: 50,
      maxChunkDurationMs: 100,
      canSend: () => !!ws && ws.readyState === WebSocket.OPEN,
      send: (pcm16) => ws?.send(pcm16),
      onChunkSent: (sentCount, chunkLength, durationMs, byteLength) => {
        getLogger().info(
          `[AssemblyAI WebSocket] Sent chunk #${sentCount} (${chunkLength} samples ~${durationMs.toFixed(1)} ms, ${byteLength} bytes)`,
        );
      },
      onError: (error) => {
        getLogger().error(
          "[AssemblyAI WebSocket] Error sending buffered chunk:",
          error,
        );
      },
    });

    const getText = () => {
      return (
        finalTranscript + (extra ? (finalTranscript ? " " : "") + extra : "")
      );
    };

    const cleanup = () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
        ws = null;
      }
      pump.resetBuffers();
    };

    const finalize = (): Promise<string> => {
      return new Promise((resolveFinalize) => {
        // resolveFinalize(finalTranscript);
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
        pump.flushPendingSamples(true);
        getLogger().info(
          "[AssemblyAI WebSocket] Total chunks sent:",
          pump.getSentChunkCount(),
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
          getLogger().info(
            "[AssemblyAI WebSocket] Sending Terminate message...",
          );
          // Send termination message
          ws.send(JSON.stringify({ type: "Terminate" }));

          // Wait a bit for final transcript
          const timeout = setTimeout(() => {
            getLogger().info(
              "[AssemblyAI WebSocket] Timeout reached, finalizing with transcript length:",
              getText().length,
            );
            cleanup();
            resolveFinalize(getText());
          }, 2000);

          // Override onclose to resolve when WebSocket closes
          const originalOnClose = ws.onclose;
          const currentWs = ws;
          ws.onclose = () => {
            clearTimeout(timeout);
            if (originalOnClose && currentWs)
              originalOnClose.call(currentWs, {} as CloseEvent);
            cleanup();
            getLogger().info(
              "[AssemblyAI WebSocket] WebSocket closed, finalizing with transcript length:",
              getText().length,
            );
            resolveFinalize(getText());
          };
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
            if (ws && ws.readyState === WebSocket.OPEN && !isFinalized) {
              try {
                const typedChunk =
                  event.payload.samples instanceof Float32Array
                    ? event.payload.samples
                    : Float32Array.from(event.payload.samples);
                pump.pushSamples(typedChunk);
                pump.flushPendingSamples();
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
