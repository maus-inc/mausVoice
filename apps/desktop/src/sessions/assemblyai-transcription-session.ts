import { getLogger } from "../utils/log.utils";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  createAudioChunkBuffer,
  createReceivedChunkLogger,
} from "./transcription-stream.utils";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";

type AssemblyAIStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
};

const LOGGER_PREFIX = "AssemblyAI WebSocket";

const startAssemblyAIStreaming = async (
  apiKey: string,
  sampleRate: number,
  onInterimResult?: (segment: string) => void,
): Promise<AssemblyAIStreamingSession> => {
  getLogger().info(`[${LOGGER_PREFIX}] Starting with sample rate:`, sampleRate);
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let unlisten: UnlistenFn | null = null;
    let isFinalized = false;
    const transcriptState = createTranscriptAccumulator();
    const receivedLogger = createReceivedChunkLogger(LOGGER_PREFIX);

    const buffer = createAudioChunkBuffer(() => ws, {
      sampleRate,
      minChunkDurationMs: 50,
      maxChunkDurationMs: 100,
      loggerPrefix: LOGGER_PREFIX,
    });

    let currentTurn = 0;

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

    const finalize = (): Promise<string> => {
      return new Promise((resolveFinalize) => {
        getLogger().info(
          `[${LOGGER_PREFIX}] Finalize called, isFinalized:`,
          isFinalized,
          "ws state:",
          ws?.readyState,
        );
        if (isFinalized) {
          getLogger().info(
            `[${LOGGER_PREFIX}] Already finalized, returning transcript`,
          );
          resolveFinalize(getText());
          return;
        }

        isFinalized = true;
        buffer.flush(true);
        getLogger().info(
          `[${LOGGER_PREFIX}] Total chunks sent:`,
          buffer.sentChunkCount(),
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
          getLogger().info(`[${LOGGER_PREFIX}] Sending Terminate message...`);
          ws.send(JSON.stringify({ type: "Terminate" }));

          const timeout = setTimeout(() => {
            getLogger().info(
              `[${LOGGER_PREFIX}] Timeout reached, finalizing with transcript length:`,
              getText().length,
            );
            cleanup();
            resolveFinalize(getText());
          }, 2000);

          const originalOnClose = ws.onclose;
          const currentWs = ws;
          ws.onclose = () => {
            clearTimeout(timeout);
            if (originalOnClose && currentWs)
              originalOnClose.call(currentWs, {} as CloseEvent);
            cleanup();
            getLogger().info(
              `[${LOGGER_PREFIX}] WebSocket closed, finalizing with transcript length:`,
              getText().length,
            );
            resolveFinalize(getText());
          };
        } else {
          cleanup();
          resolveFinalize(transcriptState.text());
        }
      });
    };

    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${sampleRate}&token=${apiKey}`;
    getLogger().info(
      `[${LOGGER_PREFIX}] Connecting (api key present:`,
      Boolean(apiKey),
      "length:",
      apiKey?.length ?? 0,
      ")",
    );
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      getLogger().info(`[${LOGGER_PREFIX}] Connected, sending auth...`);

      try {
        getLogger().info(
          `[${LOGGER_PREFIX}] Setting up audio_chunk listener...`,
        );
        unlisten = await listen<{ samples: number[] }>(
          "audio_chunk",
          (event) => {
            receivedLogger.record(event.payload.samples.length);
            if (ws && ws.readyState === WebSocket.OPEN && !isFinalized) {
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
          },
        );

        getLogger().info(`[${LOGGER_PREFIX}] Session ready, listener attached`);
        resolve({ finalize, cleanup });
      } catch (error) {
        getLogger().error(
          `[${LOGGER_PREFIX}] Error setting up listener:`,
          error,
        );
        cleanup();
        reject(error);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        getLogger().info(`[${LOGGER_PREFIX}] Received message`, {
          type: data.type,
          turnOrder: data.turn_order,
          endOfTurn: data.end_of_turn,
          transcriptLength:
            typeof data.transcript === "string" ? data.transcript.length : 0,
        });

        if (data.type === "Turn" && data.end_of_turn) {
          const turnTranscript = data.transcript || "";
          transcriptState.appendFinal(turnTranscript);
          getLogger().info(
            `[${LOGGER_PREFIX}] Final formatted transcript received, length:`,
            transcriptState.finalLength(),
          );
          if (onInterimResult && turnTranscript) {
            onInterimResult(turnTranscript);
          }
          if (currentTurn === data.turn_order) {
            transcriptState.setPartial("");
          }
        } else if (data.type === "Turn") {
          if (currentTurn != data.turn_order) {
            currentTurn = data.turn_order;

            transcriptState.setPartial(data.transcript);
          }
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
      getLogger().info(`[${LOGGER_PREFIX}] WebSocket closed:`, {
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
