import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET,
  buildProviderVocabulary,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import {
  type SocketStreamControl,
  type SocketStreamSession,
  startSocketStreamSession,
} from "./socket-stream-session";

const LOGGER_PREFIX = "AssemblyAI WebSocket";

/**
 * A provider frame that ends the stream settles a finalization that is already
 * in flight, and otherwise marks the live stream unusable. `reason` is null for
 * the acknowledgement frame and set for an error frame.
 */
const settleAtStreamEnd = (
  control: SocketStreamControl,
  reason: string | null,
): void => {
  if (control.isFinalizing()) {
    if (reason) control.fail(reason);
    else control.complete();
    return;
  }
  if (!control.isFinalized()) control.markDeliveryFailed();
};

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
): Promise<SocketStreamSession> => {
  getLogger().info(`[${LOGGER_PREFIX}] Starting with sample rate:`, sampleRate);
  const transcriptState = createTranscriptAccumulator();
  let currentTurn = 0;
  const log = (message: string, ...args: unknown[]) =>
    getLogger().info(message, ...args);

  const handleTurn = (data: {
    end_of_turn?: boolean;
    transcript?: string;
    turn_order?: number;
  }) => {
    if (data.end_of_turn) {
      const turnTranscript = data.transcript || "";
      transcriptState.appendFinal(turnTranscript);
      log(
        `[${LOGGER_PREFIX}] Final formatted transcript received, length:`,
        transcriptState.finalLength(),
      );
      if (currentTurn === data.turn_order) transcriptState.setPartial("");
      if (onInterimResult && turnTranscript) onInterimResult(turnTranscript);
      return;
    }
    if (typeof data.turn_order === "number" && data.turn_order >= currentTurn) {
      currentTurn = data.turn_order;
      transcriptState.setPartial(data.transcript ?? "");
    }
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

  return startSocketStreamSession({
    loggerPrefix: LOGGER_PREFIX,
    sampleRate,
    minChunkDurationMs: 50,
    terminationMessage: "Terminate",
    log,
    getText: () => transcriptState.text(),
    createSocket: () => new WebSocket(wsUrl),
    onConnect: () => {
      log(`[${LOGGER_PREFIX}] Connected, sending auth...`);
    },
    onReady: () => {
      log(`[${LOGGER_PREFIX}] Session ready`);
    },
    onMessage: (data, control) => {
      if (data.type === "Turn") {
        handleTurn(data);
        return;
      }
      if (data.type === "Termination") {
        settleAtStreamEnd(control, null);
        return;
      }
      if (data.type === "Error") {
        settleAtStreamEnd(
          control,
          "Streaming audio provider returned an error",
        );
      }
    },
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

  async onRecordingStart(sampleRate: number): Promise<void> {
    const generation = this.beginStreamStartup();
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
      // Must land in the inherited `streamSession` field: the base
      // `finalize()` and `cleanup()` read that field, not any local one.
      const session = await startAssemblyAIStreaming(
        this.apiKey,
        sampleRate,
        keyterms,
        this.interimForStartup(generation),
      );
      if (!this.adoptStreamSession(generation, session)) return;
      getLogger().info("[AssemblyAI] Streaming session started successfully");
    } catch {
      if (!this.ownsStreamStartup(generation)) return;
      getLogger().error("[AssemblyAI] Failed to start streaming");
    }
  }
}
