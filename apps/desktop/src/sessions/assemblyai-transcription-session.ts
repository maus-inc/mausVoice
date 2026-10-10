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
  attachStreamingSocketHandlers,
  closeStreamingSocket,
  createBufferedChunkWriter,
  createStartupSettler,
} from "./streaming-session.utils";
import { getStartupAbortReason } from "./provider-startup.utils";

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
    const transcriptState = createTranscriptAccumulator();

    const buffer = createAudioChunkBuffer(() => ws, {
      sampleRate,
      minChunkDurationMs: 50,
      maxChunkDurationMs: 100,
      loggerPrefix: LOGGER_PREFIX,
    });

    let currentTurn = 0;

    const getText = () => transcriptState.text();

    const writeAudioChunk = createBufferedChunkWriter({
      buffer,
      isFinalized: () => isFinalized,
      loggerPrefix: LOGGER_PREFIX,
    });

    const cleanup = () => {
      // Detach before closing: a socket that fires `onclose` synchronously
      // inside close() re-enters cleanup and must observe null here.
      const socket = ws;
      ws = null;
      closeStreamingSocket(socket, () => buffer.reset(), LOGGER_PREFIX);
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

    const settler = createStartupSettler<AssemblyAIStreamingSession>({
      signal,
      cleanup,
      resolve,
      reject,
      session: { finalize, cleanup, writeAudioChunk },
    });
    if (settler.settled) return;

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
      settler.rejectStartup(error);
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
          settler.resolveStartup();
          return;
        }
        if (data.type === "Error" && !settler.settled) {
          settler.rejectStartup(
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

    attachStreamingSocketHandlers({
      socket: ws,
      settler,
      cleanup,
      loggerPrefix: LOGGER_PREFIX,
      earlyCloseErrorMessage: "WebSocket closed before the session began",
      closeLogLevel: "info",
    });
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
