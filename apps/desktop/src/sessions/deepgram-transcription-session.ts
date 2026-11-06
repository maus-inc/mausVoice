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
import {
  type SocketStreamSession,
  startSocketStreamSession,
} from "./socket-stream-session";

const LOGGER_PREFIX = "Deepgram WebSocket";

const startDeepgramStreaming = async (
  apiKey: string,
  sampleRate: number,
  language: string,
  keyterms: string[],
  onInterimResult?: (segment: string) => void,
): Promise<SocketStreamSession> => {
  const transcriptState = createTranscriptAccumulator();
  const log = (message: string, ...args: unknown[]) =>
    getLogger().verbose(message, ...args);

  log(`[${LOGGER_PREFIX}] Starting with sample rate:`, sampleRate);

  const handleResults = (data: {
    channel?: { alternatives?: { transcript?: string }[] };
    is_final?: boolean;
  }) => {
    const transcriptText = data.channel?.alternatives?.[0]?.transcript || "";
    if (data.is_final !== true) {
      if (transcriptText) transcriptState.setPartial(transcriptText);
      return;
    }
    if (transcriptText) {
      transcriptState.appendFinal(transcriptText);
      transcriptState.setPartial("");
      log(
        `[${LOGGER_PREFIX}] Final transcript received, length:`,
        transcriptState.finalLength(),
      );
      onInterimResult?.(transcriptText);
    }
    // speech_final is an utterance boundary, not an end-of-stream marker.
    // More finalized utterances may still be in flight after CloseStream.
  };

  const wsUrl = buildDeepgramWebSocketUrl({
    sampleRate,
    language,
    keyterms,
  });
  log(
    `[${LOGGER_PREFIX}] Connecting to:`,
    redactQueryParamValues(wsUrl, ["keyterm"]),
  );

  return startSocketStreamSession({
    loggerPrefix: LOGGER_PREFIX,
    sampleRate,
    minChunkDurationMs: 20,
    terminationMessage: "CloseStream",
    log,
    getText: () => transcriptState.text(),
    createSocket: () => new WebSocket(wsUrl, ["token", apiKey]),
    onConnect: () => {
      log(`[${LOGGER_PREFIX}] Connected, flushing buffered audio...`);
    },
    onReady: () => {
      log(`[${LOGGER_PREFIX}] Session ready`);
    },
    onMessage: (data, control) => {
      if (data.type === "Results") {
        handleResults(data);
        return;
      }
      if (data.type === "Metadata") {
        log(`[${LOGGER_PREFIX}] Metadata received`);
        if (control.isFinalizing()) control.complete();
        return;
      }
      if (data.type === "Error" || data.error) {
        getLogger().error(`[${LOGGER_PREFIX}] Error from server`);
        if (control.isFinalizing()) {
          control.fail("Streaming audio provider returned an error");
          return;
        }
        if (!control.isFinalized()) control.markDeliveryFailed();
      }
    },
  });
};

export class DeepgramTranscriptionSession extends BaseApiTranscriptionSession {
  private startupPromise: Promise<void> | null = null;
  private startupGeneration = 0;
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
    const generation = this.beginStreamStartup();
    this.startupGeneration = generation;
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);
        if (!this.ownsStreamStartup(generation)) return;
        const { terms: keyterms, warning } = buildProviderVocabulary(
          collectDictionaryEntries(state),
          DEEPGRAM_KEYTERM_BUDGET,
          "Deepgram",
        );
        if (warning) {
          getLogger().warning(warning);
        }

        getLogger().verbose("[Deepgram] Starting streaming session...");
        const session = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          keyterms,
          this.interimForStartup(generation),
        );
        if (!this.adoptStreamSession(generation, session)) return;
        getLogger().verbose(
          "[Deepgram] Streaming session started successfully",
        );
      } catch {
        if (!this.ownsStreamStartup(generation)) return;
        getLogger().error("[Deepgram] Failed to start streaming");
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    audio: Parameters<BaseApiTranscriptionSession["finalize"]>[0],
  ) {
    const generation = this.startupGeneration;
    if (this.startupPromise) {
      await this.startupPromise;
    }
    if (!this.ownsStreamStartup(generation)) return this.notEstablishedResult();
    return super.finalize(audio);
  }
}
