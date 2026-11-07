import { getAppState } from "../store";
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { getLogger, redactQueryParamValues } from "../utils/log.utils";
import {
  buildProviderVocabulary,
  collectDictionaryEntries,
  DEEPGRAM_KEYTERM_BUDGET,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import { createAudioChunkBuffer } from "./transcription-stream.utils";
import {
  attachStreamingSocketHandlers,
  closeStreamingSocket,
  createBufferedChunkWriter,
  createFinalizeBookkeeper,
  createStartupSettler,
} from "./streaming-session.utils";
import { getStartupAbortReason } from "./provider-startup.utils";

type DeepgramStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk: (chunk: Float32Array) => void;
};

const LOGGER_PREFIX = "Deepgram WebSocket";

const startDeepgramStreaming = async (
  apiKey: string,
  sampleRate: number,
  language: string,
  keyterms: string[],
  onInterimResult?: (segment: string) => void,
  signal?: AbortSignal,
): Promise<DeepgramStreamingSession> => {
  getLogger().verbose(
    `[${LOGGER_PREFIX}] Starting with sample rate:`,
    sampleRate,
  );

  let ws: WebSocket | null = null;
  let isFinalized = false;
  // A server rejection that arrives after startup has settled, remembered so
  // finalize can surface it as a failure instead of returning a warning-free
  // empty transcript.
  let sessionError: Error | null = null;
  const transcriptState = createTranscriptAccumulator();

  const buffer = createAudioChunkBuffer(() => ws, {
    sampleRate,
    minChunkDurationMs: 20,
    maxChunkDurationMs: 100,
    loggerPrefix: LOGGER_PREFIX,
  });

  const getText = () => transcriptState.text();

  const cleanup = () => {
    // Detach before closing: a socket that fires `onclose` synchronously
    // inside close() re-enters cleanup and must observe null here.
    const socket = ws;
    ws = null;
    closeStreamingSocket(socket, () => buffer.reset(), LOGGER_PREFIX);
  };

  const bookkeeper = createFinalizeBookkeeper({
    cleanup,
    getText,
    loggerPrefix: LOGGER_PREFIX,
  });

  const finalize = (): Promise<string> => {
    return new Promise((resolveFinalize, rejectFinalize) => {
      // A rejection that landed after startup left the socket unable to
      // deliver a transcript. Settling such a finalize with "" would produce a
      // warning-free empty result that bypasses failed-audio recovery, so a
      // rejected session with no transcript settles as a failure instead.
      // Transcript text already accumulated is still returned.
      const settleFinalize = () => {
        const text = getText();
        if (sessionError && !text) {
          rejectFinalize(sessionError);
          return;
        }
        resolveFinalize(text);
      };

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
        settleFinalize();
        return;
      }

      isFinalized = true;
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
        bookkeeper.begin(settleFinalize);
        bookkeeper.armTimeout(
          3000,
          "Timeout reached, finalizing with transcript length:",
        );
      } else {
        cleanup();
        settleFinalize();
      }
    });
  };

  const writeAudioChunk = createBufferedChunkWriter({
    buffer,
    isFinalized: () => isFinalized,
    loggerPrefix: LOGGER_PREFIX,
  });

  return new Promise((resolve, reject) => {
    const settler = createStartupSettler<DeepgramStreamingSession>({
      signal,
      cleanup,
      resolve,
      reject,
      session: { finalize, cleanup, writeAudioChunk },
    });
    if (settler.settled) return;

    const wsUrl = buildDeepgramWebSocketUrl({
      sampleRate,
      language,
      keyterms,
    });
    getLogger().verbose(
      `[${LOGGER_PREFIX}] Connecting to:`,
      redactQueryParamValues(wsUrl, ["keyterm"]),
    );
    try {
      ws = new WebSocket(wsUrl, ["token", apiKey]);
    } catch (error) {
      settler.rejectStartup(error);
      return;
    }

    ws.onopen = () => {
      if (signal?.aborted) {
        settler.rejectStartup(getStartupAbortReason(signal));
        return;
      }
      getLogger().verbose(
        `[${LOGGER_PREFIX}] Connected, flushing buffered audio...`,
      );
      buffer.flush(false);
      getLogger().verbose(`[${LOGGER_PREFIX}] Session ready`);
      settler.resolveStartup();
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
              bookkeeper.complete();
            }
          } else if (!isFinal && transcriptText) {
            transcriptState.setPartial(transcriptText);
          }
        } else if (messageType === "Metadata") {
          getLogger().verbose(`[${LOGGER_PREFIX}] Metadata received:`, data);
        } else if (messageType === "Error" || data.error) {
          getLogger().error(`[${LOGGER_PREFIX}] Error from server:`, data);
          if (!settler.settled) {
            settler.rejectStartup(
              new Error("Deepgram rejected the streaming session"),
            );
          } else {
            // Deepgram can reject a session that already opened (for example
            // when the key loses access mid-recording). The socket will not
            // deliver further transcripts, so the recording's empty result
            // must carry this failure, not pass as warning-free.
            sessionError = new Error(
              String(
                data.message ??
                  data.error ??
                  "Deepgram rejected the streaming session",
              ),
            );
            cleanup();
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
      earlyCloseErrorMessage: "WebSocket closed before the connection opened",
      onSettledClose: () => {
        if (isFinalized) bookkeeper.complete();
      },
    });
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

  async onRecordingStart(
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);
        if (signal?.aborted) throw getStartupAbortReason(signal);
        const { terms: keyterms, warning } = buildProviderVocabulary(
          collectDictionaryEntries(state),
          DEEPGRAM_KEYTERM_BUDGET,
          "Deepgram",
        );
        if (warning) {
          getLogger().warning(warning);
        }

        getLogger().verbose("[Deepgram] Starting streaming session...");
        this.streamSession = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          keyterms,
          this.interimCallback ?? undefined,
          signal,
        );
        getLogger().verbose(
          "[Deepgram] Streaming session started successfully",
        );
      } catch (error) {
        getLogger().error("[Deepgram] Failed to start streaming:", error);
        throw error;
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    audio: Parameters<BaseApiTranscriptionSession["finalize"]>[0],
  ) {
    if (this.startupPromise) {
      await this.startupPromise.catch(() => undefined);
    }
    return super.finalize(audio);
  }
}
