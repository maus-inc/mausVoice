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
import { drainSamples } from "./audio-buffer.utils";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { createTranscriptAccumulator } from "./transcript-accumulator.utils";
import {
  attachStreamingSocketHandlers,
  closeStreamingSocket,
  createFinalizeBookkeeper,
  createStartupSettler,
} from "./streaming-session.utils";
import { getStartupAbortReason } from "./provider-startup.utils";

type ElevenLabsStreamingSession = {
  finalize: () => Promise<string>;
  cleanup: () => void;
  writeAudioChunk: (chunk: Float32Array) => void;
};

const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

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

const resampleAudio = (
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array => {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.ceil(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcFloor;
    const a = input[srcFloor] ?? 0;
    const b = input[Math.min(srcFloor + 1, input.length - 1)] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
};

const getElevenLabsToken = async (
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> => {
  const response = await secureFetch(ELEVENLABS_TOKEN_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
    signal,
  });

  if (!response.ok) {
    const textSnippet = await response.text().catch(() => "");
    if (textSnippet) {
      const snippet =
        textSnippet.length > 200
          ? `${textSnippet.slice(0, 200)}...`
          : textSnippet;
      getLogger().verbose(
        "[ElevenLabs] Token fetch failed, response snippet:",
        snippet,
      );
    } else {
      getLogger().verbose(
        `[ElevenLabs] Token request failed with status ${response.status}`,
      );
    }
    throw new Error(`Failed to get ElevenLabs token: ${response.status}`);
  }

  const data = await response.json();
  return data.token;
};

const startElevenLabsStreaming = async (
  apiKey: string,
  inputSampleRate: number,
  keyterms: string[],
  onInterimResult?: (segment: string) => void,
  signal?: AbortSignal,
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
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * MIN_CHUNK_DURATION_MS) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * MAX_CHUNK_DURATION_MS) / 1000),
  );

  const token = await getElevenLabsToken(apiKey, signal);
  if (signal?.aborted) throw getStartupAbortReason(signal);
  getLogger().verbose("[ElevenLabs WebSocket] Got single-use token");

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let isFinalized = false;
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
        return;
      }

      try {
        const base64Audio = convertFloat32ToBase64PCM16(chunk);
        const message = JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64Audio,
          commit,
          sample_rate: sampleRate,
        });
        ws.send(message);
        sentChunkCount++;
        if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
          const durationMs = (chunk.length / sampleRate) * 1000;
          getLogger().verbose(
            `[ElevenLabs WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms)`,
          );
        }
      } catch (error) {
        getLogger().error("[ElevenLabs WebSocket] Error sending chunk:", error);
      }
    };

    const sendTerminalCommit = () => {
      try {
        ws?.send(JSON.stringify({ message_type: "commit" }));
      } catch (error) {
        getLogger().error(
          "[ElevenLabs WebSocket] Error sending terminal commit:",
          error,
        );
      }
    };

    const resolveChunkSize = (available: number, force: boolean) => {
      if (available >= maxSamplesPerChunk) return maxSamplesPerChunk;
      if (available < minSamplesPerChunk && !force) return 0;
      return available;
    };

    const flushPendingSamples = (force = false) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (force && pendingSampleCountRef.value === 0) {
        // Guard the terminal commit send the same way sendAudioChunk guards a
        // normal send. A socket that closes between the readyState check and
        // this send would otherwise reject finalize() instead of degrading to
        // a transcript.
        sendTerminalCommit();
        return;
      }

      while (
        pendingSampleCountRef.value >= minSamplesPerChunk ||
        (force && pendingSampleCountRef.value > 0)
      ) {
        const available = pendingSampleCountRef.value;
        const chunkSize = resolveChunkSize(available, force);
        if (chunkSize === 0) {
          break;
        }

        let chunk = drain(chunkSize);
        if (force && chunk.length > 0 && chunk.length < minSamplesPerChunk) {
          const padded = new Float32Array(minSamplesPerChunk);
          padded.set(chunk);
          chunk = padded;
        }

        if (chunk.length === 0) {
          break;
        }

        const isLastChunk = force && pendingSampleCountRef.value === 0;
        sendAudioChunk(chunk, isLastChunk);
      }
    };

    const writeAudioChunk = (rawChunk: Float32Array) => {
      if (isFinalized) return;
      // Queue only for a socket that is still able to receive. The test is
      // `readyState`, not `ws`: `cleanup` only nulls the socket when it is not
      // already CLOSED, so after a normal close `ws` is still the closed socket,
      // and a `!ws` guard would have changed nothing at all.
      //
      // There is no reconnect to queue for. The comment this replaces spoke of
      // "reconnecting", but nothing in this session ever opens a second socket,
      // so `flushPendingSamples` below stayed a no-op for the rest of the
      // recording while every chunk pushed into `pendingChunks` stayed there
      // too: hours of audio, retained, never sent, until `finalize` released it.
      if (
        !ws ||
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        return;
      }
      try {
        const typedChunk = needsResample
          ? resampleAudio(rawChunk, inputSampleRate, sampleRate)
          : rawChunk;
        // Queued unconditionally; `flushPendingSamples` is what decides whether
        // the socket can take it, and `finalize` drains what is left with
        // `force`.
        //
        // There is no "captured while connecting" case to cover here, which is
        // what this comment used to promise. `writeAudioChunk` is handed out
        // from `ws.onopen` and not before, so the socket is OPEN by the time any
        // caller can reach this; audio written during the handshake never gets
        // this far, because the base session has no stream session to forward it
        // to until then. The guard above is the one that earns its keep: a
        // socket that closed under us leaves this queue with nowhere to go.
        pendingChunks.push(typedChunk);
        pendingSampleCountRef.value += typedChunk.length;
        flushPendingSamples(false);
      } catch (error) {
        getLogger().error(
          "[ElevenLabs WebSocket] Error sending audio chunk:",
          error,
        );
      }
    };

    const cleanup = () => {
      // Detach before closing: a socket that fires `onclose` synchronously
      // inside close() re-enters cleanup and must observe null here.
      const socket = ws;
      ws = null;
      closeStreamingSocket(socket, resetBuffers, "ElevenLabs WebSocket");
    };

    const bookkeeper = createFinalizeBookkeeper({
      cleanup,
      getText,
      loggerPrefix: "ElevenLabs WebSocket",
    });

    const finalize = (): Promise<string> => {
      return new Promise((resolveFinalize) => {
        getLogger().verbose(
          "[ElevenLabs WebSocket] Finalize called, isFinalized:",
          isFinalized,
          "ws state:",
          ws?.readyState,
        );
        if (isFinalized) {
          getLogger().verbose(
            "[ElevenLabs WebSocket] Already finalized, returning transcript",
          );
          resolveFinalize(getText());
          return;
        }

        isFinalized = true;

        flushPendingSamples(true);
        getLogger().verbose(
          "[ElevenLabs WebSocket] Total chunks sent:",
          sentChunkCount,
          "- waiting for final transcript...",
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
          bookkeeper.begin(resolveFinalize);
          bookkeeper.armTimeout(
            6000,
            "Timeout waiting for final transcript, length:",
          );
        } else {
          cleanup();
          resolveFinalize(getText());
        }
      });
    };

    const settler = createStartupSettler<ElevenLabsStreamingSession>({
      signal,
      cleanup,
      resolve,
      reject,
      session: { finalize, cleanup, writeAudioChunk },
    });
    if (settler.settled) return;

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
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      settler.rejectStartup(error);
      return;
    }

    ws.onopen = () => {
      getLogger().verbose(
        "[ElevenLabs WebSocket] Connected, awaiting session start",
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const messageType = data.message_type || data.type;
        getLogger().verbose(
          "[ElevenLabs WebSocket] Received message:",
          messageType,
          data,
        );

        if (messageType === "committed_transcript") {
          const committedText = data.text || "";
          transcriptState.appendFinal(committedText);
          transcriptState.setPartial("");
          getLogger().verbose(
            "[ElevenLabs WebSocket] Committed chunk appended, length:",
            committedText.length,
          );
          if (onInterimResult && committedText) {
            onInterimResult(committedText);
          }
          if (isFinalized) {
            bookkeeper.complete();
          }
        } else if (messageType === "partial_transcript") {
          transcriptState.setPartial(data.text || "");
        } else if (messageType === "session_started") {
          getLogger().verbose("[ElevenLabs WebSocket] Session started:", data);
          flushPendingSamples(false);
          settler.resolveStartup();
        } else if (
          typeof messageType === "string" &&
          messageType.toLowerCase().includes("error")
        ) {
          getLogger().error("[ElevenLabs WebSocket] Error from server:", data);
          if (!settler.settled) {
            settler.rejectStartup(
              new Error(
                String(
                  data.error ??
                    data.message ??
                    "ElevenLabs rejected the session",
                ),
              ),
            );
          }
        }
      } catch (error) {
        getLogger().error(
          "[ElevenLabs WebSocket] Error parsing message:",
          error,
        );
      }
    };

    attachStreamingSocketHandlers({
      socket: ws,
      settler,
      cleanup,
      loggerPrefix: "ElevenLabs WebSocket",
      earlyCloseErrorMessage: "WebSocket closed before the session started",
    });
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

  async onRecordingStart(
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
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
      this.streamSession = await startElevenLabsStreaming(
        this.apiKey,
        sampleRate,
        keyterms,
        this.interimCallback ?? undefined,
        signal,
      );
      getLogger().verbose(
        "[ElevenLabs] Streaming session started successfully",
      );
    } catch (error) {
      getLogger().error("[ElevenLabs] Failed to start streaming:", error);
      throw error;
    }
  }
}
