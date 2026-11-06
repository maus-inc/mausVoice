import {
  appendQueryParamValues,
  convertFloat32ToBase64PCM16,
} from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import { getMyUserPreferences } from "../utils/user.utils";
import { getLogger, redactQueryParamValues } from "../utils/log.utils";
import {
  buildProviderVocabulary,
  collectDictionaryEntries,
  ELEVENLABS_REALTIME_KEYTERMS_BUDGET,
} from "../utils/prompt.utils";
import { secureFetch } from "../utils/secure-fetch.utils";
import {
  audioChunkSampleBounds,
  drainSamples,
  padFinalAudioChunk,
} from "./audio-buffer.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createStreamingResampler } from "../utils/gladia.utils";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import {
  createWebSocketStartup,
  MAX_SOCKET_BUFFERED_BYTES,
} from "./transcription-stream.utils";

type ElevenLabsStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk: (chunk: Float32Array) => void;
};

/** Queue bounds for audio that a stalled socket has not taken yet. */
const MAX_PENDING_CHUNKS = 1024;
const MAX_QUEUED_SECONDS = 30;

const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

const ERROR_MESSAGE_TYPES = new Set([
  "error",
  "input_error",
  "transcriber_error",
  "auth_error",
  "quota_exceeded",
  "invalid_request",
  "commit_throttled",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
  "rate_limited",
  "unaccepted_terms",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
]);
const SERVER_MESSAGE_TYPES = new Set([
  "committed_transcript",
  "partial_transcript",
  "session_started",
  ...ERROR_MESSAGE_TYPES,
]);

const safeServerMessageType = (type: string | undefined): string =>
  type && SERVER_MESSAGE_TYPES.has(type) ? type : "unknown";

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

const getClosestSupportedSampleRate = (sampleRate: number): number => {
  let closest = SUPPORTED_SAMPLE_RATES[0];
  let minDiff = Math.abs(sampleRate - closest);

  for (const supported of SUPPORTED_SAMPLE_RATES) {
    const diff = Math.abs(sampleRate - supported);
    if (diff < minDiff) {
      minDiff = diff;
      closest = supported;
    }
  }

  return closest;
};

const getElevenLabsToken = async (apiKey: string): Promise<string> => {
  const response = await secureFetch(ELEVENLABS_TOKEN_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
  });

  if (!response.ok) {
    // Provider error bodies can echo credentials or other sensitive data.
    // The status is sufficient for diagnostics and does not require consuming it.
    getLogger().verbose(
      `[ElevenLabs] Token request failed with status ${response.status}`,
    );
    throw new Error(`Failed to get ElevenLabs token: ${response.status}`);
  }

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("token" in data) ||
    typeof data.token !== "string" ||
    !data.token.trim()
  ) {
    throw new Error("ElevenLabs token response did not contain a valid token");
  }
  return data.token;
};

const startElevenLabsStreaming = async (
  apiKey: string,
  inputSampleRate: number,
  keyterms: string[],
  onInterimResult?: (segment: string) => void,
): Promise<ElevenLabsStreamingSession> => {
  const sampleRate = SUPPORTED_SAMPLE_RATES.includes(inputSampleRate)
    ? inputSampleRate
    : getClosestSupportedSampleRate(inputSampleRate);

  const needsResample = sampleRate !== inputSampleRate;
  if (needsResample) {
    console.warn(
      `[ElevenLabs WebSocket] Sample rate ${inputSampleRate} not supported, resampling to ${sampleRate}.`,
    );
  }

  getLogger().verbose(
    "[ElevenLabs WebSocket] Starting with sample rate:",
    sampleRate,
  );

  const MIN_CHUNK_DURATION_MS = 20;
  const MAX_CHUNK_DURATION_MS = 100;
  const { minSamplesPerChunk, maxSamplesPerChunk } = audioChunkSampleBounds(
    sampleRate,
    MIN_CHUNK_DURATION_MS,
    MAX_CHUNK_DURATION_MS,
  );

  const token = await getElevenLabsToken(apiKey);
  getLogger().verbose("[ElevenLabs WebSocket] Got single-use token");

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let isFinalized = false;
    let isFlushingFinalAudio = false;
    let retired = false;
    let deliveryFailure: string | null = null;
    const resampler = needsResample
      ? createStreamingResampler(inputSampleRate, sampleRate)
      : null;
    let sentChunkCount = 0;
    let pendingChunks: Float32Array[] = [];
    const pendingSampleCountRef = { value: 0 };
    const transcriptState = createTranscriptAccumulator();

    const getText = () => transcriptState.text();

    const resetBuffers = () => {
      pendingChunks = [];
      pendingSampleCountRef.value = 0;
    };

    const drain = (targetCount: number) =>
      drainSamples(pendingChunks, pendingSampleCountRef, targetCount);

    const sendAudioChunk = (chunk: Float32Array, commit: boolean) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      try {
        const base64Audio = convertFloat32ToBase64PCM16(chunk);
        const message = JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64Audio,
          commit,
          sample_rate: sampleRate,
        });
        if (
          (ws.bufferedAmount ?? 0) + message.length >
          MAX_SOCKET_BUFFERED_BYTES
        ) {
          deliveryFailure = "ElevenLabs audio queue limit reached";
          return false;
        }
        ws.send(message);
        sentChunkCount++;
        if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
          const durationMs = (chunk.length / sampleRate) * 1000;
          getLogger().verbose(
            `[ElevenLabs WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms)`,
          );
        }
        return true;
      } catch {
        getLogger().error("[ElevenLabs WebSocket] Error sending chunk");
        return false;
      }
    };

    // Scribe accepts a commit flag on an input_audio_chunk, not a standalone
    // "commit" message. Empty audio is valid when no tail samples remain.
    const sendTerminalCommit = (): boolean =>
      sendAudioChunk(new Float32Array(0), true);

    /** Drain one provider-sized chunk, restoring it if the send fails. */
    const sendNextChunk = (force: boolean): boolean => {
      const available = pendingSampleCountRef.value;
      if (available === 0 || (available < minSamplesPerChunk && !force))
        return false;
      const original = drain(Math.min(available, maxSamplesPerChunk));
      const chunk = padFinalAudioChunk(original, minSamplesPerChunk, force);
      if (chunk.length === 0) return false;
      const isLastChunk = force && pendingSampleCountRef.value === 0;
      if (sendAudioChunk(chunk, isLastChunk)) return true;
      pendingChunks.unshift(original);
      pendingSampleCountRef.value += original.length;
      return false;
    };

    const flushPendingSamples = (force = false): boolean => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      if (force && pendingSampleCountRef.value === 0) {
        // A socket can close after the readyState check, so the terminal send
        // is guarded independently from normal audio sends.
        return sendTerminalCommit();
      }
      while (sendNextChunk(force)) {
        // Drain complete chunks until the queue is empty or a send fails.
      }
      return pendingSampleCountRef.value === 0;
    };

    /**
     * A failed send can be retried, but only while its queue stays bounded: an
     * unbounded queue would swallow the recording's memory when the socket
     * stalls.
     */
    const queueHasRoom = (incomingSamples: number): boolean =>
      pendingChunks.length < MAX_PENDING_CHUNKS &&
      pendingSampleCountRef.value + incomingSamples <=
        sampleRate * MAX_QUEUED_SECONDS;

    const writeAudioChunk = (rawChunk: Float32Array) => {
      if (isFinalized || retired || deliveryFailure) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        failStream("ElevenLabs connection closed before finalization");
        return;
      }
      try {
        const typedChunk = resampler?.process(rawChunk) ?? rawChunk;
        if (typedChunk.length === 0) return;
        if (!queueHasRoom(typedChunk.length)) {
          failStream("ElevenLabs audio queue limit reached");
          return;
        }
        // Failed sends can leave chunks queued beyond this call. Own the
        // samples rather than retaining a caller-mutable view.
        pendingChunks.push(typedChunk.slice());
        pendingSampleCountRef.value += typedChunk.length;
        flushPendingSamples(false);
        if (deliveryFailure) failStream(deliveryFailure);
      } catch {
        failStream("ElevenLabs audio processing failed");
      }
    };

    let resolveFinal: ((text: string) => void) | null = null;
    let rejectFinal: ((error: Error) => void) | null = null;
    let finalTimer: ReturnType<typeof setTimeout> | null = null;
    let finalPromise: Promise<string> | null = null;

    const retire = () => {
      retired = true;
      const socket = ws;
      ws = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try {
          socket.close();
        } catch {
          getLogger().warning("[ElevenLabs WebSocket] Socket cleanup failed");
        }
      }
      resetBuffers();
      resampler?.reset();
    };

    const settleFinal = (failure?: string) => {
      const resolve = resolveFinal;
      const reject = rejectFinal;
      if (!resolve || !reject) return;
      resolveFinal = null;
      rejectFinal = null;
      if (finalTimer !== null) clearTimeout(finalTimer);
      finalTimer = null;
      retire();
      if (failure) reject(new Error(failure));
      else resolve(getText());
    };

    const cleanup = () => {
      if (resolveFinal) settleFinal("ElevenLabs stream was cancelled");
      else retire();
    };

    const failStream = (message: string) => {
      deliveryFailure ??= message;
      if (resolveFinal && !isFlushingFinalAudio) settleFinal(deliveryFailure);
      else if (!isFinalized) retire();
    };

    /** True while the socket can still take the terminal audio and commit. */
    const socketAcceptsFinalAudio = (): boolean =>
      !deliveryFailure && !retired && !!ws && ws.readyState === WebSocket.OPEN;

    /** Send the resampler tail, then the last audio and the terminal commit. */
    const sendFinalAudioAndCommit = (): string | null => {
      try {
        const tail = resampler?.flush();
        if (tail?.length) {
          pendingChunks.push(tail);
          pendingSampleCountRef.value += tail.length;
        }
        isFlushingFinalAudio = true;
        // A failed first attempt can leave the queue drained in part, so the
        // terminal send is retried once before the recording is called lost.
        let sent = flushPendingSamples(true);
        if (!sent) sent = flushPendingSamples(true);
        isFlushingFinalAudio = false;
        if (deliveryFailure) return deliveryFailure;
        return sent
          ? null
          : "Unable to send final audio or commit to ElevenLabs";
      } catch {
        isFlushingFinalAudio = false;
        return "Unable to send final audio or commit to ElevenLabs";
      }
    };

    const finalize = (): Promise<string> => {
      if (finalPromise) return finalPromise;
      finalPromise = new Promise((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
      });
      isFinalized = true;
      if (!socketAcceptsFinalAudio()) {
        settleFinal(
          deliveryFailure ?? "ElevenLabs connection closed before finalization",
        );
        return finalPromise;
      }
      const sendFailure = sendFinalAudioAndCommit();
      if (sendFailure) {
        settleFinal(sendFailure);
        return finalPromise;
      }
      if (resolveFinal) {
        finalTimer = setTimeout(
          () => settleFinal("ElevenLabs finalization timed out"),
          15_000,
        );
      }
      return finalPromise;
    };

    // This is a per-segment event, not a correlated terminal acknowledgement:
    // a VAD commit already in flight can still arrive after our final commit.
    const completeFinalize = () => settleFinal();

    const audioFormat = `pcm_${sampleRate}`;
    // Keyterm prompting: repeated `keyterms` query parameters bias the
    // realtime model toward the user's dictionary vocabulary. Built with
    // URLSearchParams so encoding matches Deepgram's path.
    const params = new URLSearchParams({
      token,
      model_id: "scribe_v2_realtime",
      audio_format: audioFormat,
      commit_strategy: "vad",
    });
    appendQueryParamValues(params, "keyterms", keyterms);
    const wsUrl = `${ELEVENLABS_WS_URL}?${params.toString()}`;
    getLogger().verbose(
      "[ElevenLabs WebSocket] Connecting to:",
      redactQueryParamValues(wsUrl, ["token", "keyterms"]),
    );
    ws = new WebSocket(wsUrl);

    const startup = createWebSocketStartup(
      "ElevenLabs WebSocket",
      cleanup,
      resolve,
      reject,
    );
    ws.onopen = () =>
      startup.open(() => {
        getLogger().verbose("[ElevenLabs WebSocket] Connected");
        flushPendingSamples(false);
        getLogger().verbose("[ElevenLabs WebSocket] Session ready");
        return { finalize, cleanup, writeAudioChunk };
      });

    const handleCommittedTranscript = (committedText: string) => {
      transcriptState.appendFinal(committedText);
      transcriptState.setPartial("");
      getLogger().verbose(
        "[ElevenLabs WebSocket] Committed chunk appended, length:",
        committedText.length,
      );
      try {
        if (onInterimResult && committedText) onInterimResult(committedText);
      } finally {
        if (isFinalized && !isFlushingFinalAudio && !deliveryFailure)
          completeFinalize();
      }
    };

    const handleServerMessage = (data: {
      message_type?: string;
      type?: string;
      text?: string;
    }) => {
      const messageType = data.message_type || data.type;
      // Provider messages can contain dictated text or echoed credentials.
      // Log only known message kinds, never the payload or an unknown kind.
      getLogger().verbose(
        "[ElevenLabs WebSocket] Received message:",
        safeServerMessageType(messageType),
      );
      if (messageType === "committed_transcript") {
        handleCommittedTranscript(data.text || "");
      } else if (messageType === "partial_transcript") {
        transcriptState.setPartial(data.text || "");
      } else if (messageType === "session_started") {
        getLogger().verbose("[ElevenLabs WebSocket] Session started");
      } else if (messageType && ERROR_MESSAGE_TYPES.has(messageType)) {
        getLogger().error(
          "[ElevenLabs WebSocket] Error from server:",
          messageType,
        );
        failStream("ElevenLabs reported a streaming error");
      }
    };

    ws.onmessage = (event) => {
      if (retired || deliveryFailure) return;
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch {
        // Parser and consumer exceptions can contain provider-supplied text.
        getLogger().error("[ElevenLabs WebSocket] Error processing message");
      }
    };

    ws.onerror = (event) => {
      if (retired) return;
      failStream("ElevenLabs connection failed");
      startup.error(event);
    };

    ws.onclose = (event) => {
      if (retired) return;
      getLogger().verbose("[ElevenLabs WebSocket] WebSocket closed:", {
        code: event.code,
      });
      if (startup.closedBeforeOpen()) return;
      failStream("ElevenLabs connection closed before finalization");
      if (!isFlushingFinalAudio) retire();
    };
  });
};

export class ElevenLabsTranscriptionSession extends BaseApiTranscriptionSession {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super({
      providerLabel: "ElevenLabs",
      inferenceDevice: "API • ElevenLabs (Streaming)",
    });
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    const generation = this.beginStreamStartup();
    try {
      getLogger().verbose("[ElevenLabs] Starting streaming session...");
      const keytermsEnabled =
        getMyUserPreferences(getAppState())?.elevenLabsKeytermsEnabled ?? false;
      let keyterms: string[] = [];
      if (keytermsEnabled) {
        const { terms: computedKeyterms, warning } = buildProviderVocabulary(
          collectDictionaryEntries(getAppState()),
          ELEVENLABS_REALTIME_KEYTERMS_BUDGET,
          "ElevenLabs",
        );
        if (warning) {
          getLogger().warning(warning);
        }
        keyterms = computedKeyterms;
      }
      const session = await startElevenLabsStreaming(
        this.apiKey,
        sampleRate,
        keyterms,
        this.interimForStartup(generation),
      );
      if (!this.adoptStreamSession(generation, session)) return;
      getLogger().verbose(
        "[ElevenLabs] Streaming session started successfully",
      );
    } catch {
      if (!this.ownsStreamStartup(generation)) return;
      getLogger().error("[ElevenLabs] Failed to start streaming");
    }
  }
}
