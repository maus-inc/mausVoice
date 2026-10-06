import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET,
  buildProviderVocabulary,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import { createAudioChunkBuffer } from "./transcription-stream.utils";
import {
  addStartupAbortListener,
  getStartupAbortReason,
} from "./provider-startup.utils";

type AssemblyAIStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk: (chunk: Float32Array) => void;
};

const LOGGER_PREFIX = "AssemblyAI WebSocket";

/**
 * Opens an AssemblyAI v3 streaming WebSocket. The `speech_model` query
 * parameter pins the universal streaming model that supports `keyterms_prompt`
 * biasing; without it the account default may be an older model that silently
 * ignores the keyterms. `keyterms` (the user's dictionary, already capped to
 * the streaming budget) is sent as a JSON array when non-empty.
 */
export const startAssemblyAIStreaming = async (
  apiKey: string,
  sampleRate: number,
  keyterms: string[],
  onInterimResult?: (segment: string) => void,
  signal?: AbortSignal,
): Promise<AssemblyAIStreamingSession> => {
  getLogger().info(`[${LOGGER_PREFIX}] Starting with sample rate:`, sampleRate);
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let isFinalized = false;
    let startupSettled = false;
    let removeAbortListener: () => void = () => undefined;
    const transcriptState = createTranscriptAccumulator();

    const buffer = createAudioChunkBuffer(() => ws, {
      sampleRate,
      minChunkDurationMs: 50,
      maxChunkDurationMs: 100,
      loggerPrefix: LOGGER_PREFIX,
    });

    let currentTurn = 0;

    const getText = () => transcriptState.text();

    const writeAudioChunk = (chunk: Float32Array) => {
      if (isFinalized) return;
      try {
        // Always queue the chunk, even while the socket is still connecting.
        // flush() is a no-op until the socket is OPEN and onopen drains the
        // backlog, so speech captured during connect is not lost.
        buffer.push(chunk);
        buffer.flush(false);
      } catch (error) {
        getLogger().error(
          `[${LOGGER_PREFIX}] Error sending audio chunk:`,
          error,
        );
      }
    };

    const cleanup = () => {
      const socket = ws;
      ws = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try {
          socket.close();
        } catch (error) {
          getLogger().warning(
            `[${LOGGER_PREFIX}] Failed to close the WebSocket: ${error}`,
          );
        }
      }
      buffer.reset();
    };

    const rejectStartup = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      removeAbortListener();
      cleanup();
      reject(error);
    };
    const resolveStartup = () => {
      if (startupSettled) return;
      startupSettled = true;
      removeAbortListener();
      resolve({ finalize, cleanup, writeAudioChunk });
    };

    removeAbortListener = addStartupAbortListener(signal, rejectStartup);
    if (startupSettled) return;

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

    // Keyterms prompting: a JSON-encoded array of terms (up to 100, each at
    // most 50 characters) biases the streaming model toward the user's
    // dictionary vocabulary.
    const keytermsPrompt =
      keyterms.length > 0
        ? `&keyterms_prompt=${encodeURIComponent(JSON.stringify(keyterms))}`
        : "";
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${sampleRate}&speech_model=universal-3-5-pro&token=${encodeURIComponent(apiKey)}${keytermsPrompt}`;
    getLogger().info(
      `[${LOGGER_PREFIX}] Connecting (api key present:`,
      Boolean(apiKey),
      "length:",
      apiKey?.length ?? 0,
      ")",
    );
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      rejectStartup(error);
      return;
    }

    ws.onopen = () => {
      getLogger().info(`[${LOGGER_PREFIX}] WebSocket opened, awaiting Begin`);
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

        if (data.type === "Begin") {
          getLogger().info(`[${LOGGER_PREFIX}] Session ready`);
          buffer.flush(false);
          resolveStartup();
          return;
        }
        if (data.type === "Error" && !startupSettled) {
          rejectStartup(
            new Error(
              String(
                data.error ?? data.message ?? "AssemblyAI rejected the session",
              ),
            ),
          );
          return;
        }

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
      if (!startupSettled) {
        rejectStartup(new Error("WebSocket connection failed"));
      } else {
        cleanup();
      }
    };

    ws.onclose = (event) => {
      getLogger().info(`[${LOGGER_PREFIX}] WebSocket closed:`, {
        code: event.code,
        reason: event.reason,
      });
      if (!startupSettled) {
        rejectStartup(new Error("WebSocket closed before the session began"));
        return;
      }
      cleanup();
    };
  });
};

export class AssemblyAITranscriptionSession extends BaseApiTranscriptionSession {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super({
      providerLabel: "AssemblyAI",
      inferenceDevice: "API • AssemblyAI (Streaming)",
    });
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async onRecordingStart(
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      getLogger().info("[AssemblyAI] Starting streaming session...");
      const { terms: keyterms, warning } = buildProviderVocabulary(
        collectDictionaryEntries(getAppState()),
        ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET,
        "AssemblyAI",
      );
      if (warning) {
        getLogger().warning(warning);
      }
      if (signal?.aborted) throw getStartupAbortReason(signal);
      this.streamSession = await startAssemblyAIStreaming(
        this.apiKey,
        sampleRate,
        keyterms,
        this.interimCallback ?? undefined,
        signal,
      );
      getLogger().info("[AssemblyAI] Streaming session started successfully");
    } catch (error) {
      getLogger().error("[AssemblyAI] Failed to start streaming:", error);
      throw error;
    }
  }
}
