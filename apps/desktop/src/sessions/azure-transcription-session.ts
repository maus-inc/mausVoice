import { createAzureStreamingSession } from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  AZURE_PHRASE_LIST_BUDGET,
  buildProviderVocabulary,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { createStreamingSpeechDownsampler } from "../utils/speech-resample.utils";
import {
  createStreamingResampler,
  type StreamingResampler,
} from "../utils/gladia.utils";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { BaseApiTranscriptionSession } from "./base-api-transcription-session";
import { failedCaptureResult } from "./recording-transcription.utils";

type AzureResampler = {
  resampler: ReturnType<typeof createStreamingResampler>;
  outputRate: number;
};

/**
 * Azure's PCM input contract supports 8 kHz and 16 kHz mono. An unsupported
 * microphone rate is rejected rather than silently sent at the wrong rate, and
 * an uncommon rate that the filter table cannot cover falls back to linear
 * resampling with a warning.
 */
const createAzureResampler = (sampleRate: number): AzureResampler => {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 1_000 ||
    sampleRate > 768_000
  ) {
    throw new Error("Unsupported microphone sample rate");
  }
  const outputRate = sampleRate === 8_000 ? 8_000 : 16_000;
  const filteredResampler = createStreamingSpeechDownsampler(
    sampleRate,
    outputRate,
  );
  if (sampleRate > outputRate && !filteredResampler) {
    getLogger().warning(
      "[Azure] Using linear resampling for an uncommon microphone rate",
    );
  }
  return {
    resampler:
      filteredResampler ?? createStreamingResampler(sampleRate, outputRate),
    outputRate,
  };
};

export class AzureTranscriptionSession extends BaseApiTranscriptionSession {
  private startupAbort: AbortController | null = null;
  private resampler: StreamingResampler | null = null;
  private finalization: Promise<TranscriptionSessionResult> | null = null;
  private startupGeneration = 0;
  private readonly subscriptionKey: string;
  private readonly region: string;

  constructor(subscriptionKey: string, region: string) {
    super({
      providerLabel: "Azure",
      inferenceDevice: "API • Azure (Streaming)",
    });
    this.subscriptionKey = subscriptionKey;
    this.region = region;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    const generation = this.beginStreamStartup();
    this.startupGeneration = generation;
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    try {
      getLogger().verbose("[Azure] Starting streaming session...");
      const { resampler, outputRate } = createAzureResampler(sampleRate);
      const state = getAppState();
      const language = await loadMyEffectiveDictationLanguage(state);
      if (!this.ownsStreamStartup(generation)) return;
      // Azure's phrase list takes plain terms (multi-word phrases included),
      // never the localized prompt sentence, because instruction words
      // like "Glossary:" or "transcribing" would bias recognition.
      const { terms: phrases, warning } = buildProviderVocabulary(
        collectDictionaryEntries(state),
        AZURE_PHRASE_LIST_BUDGET,
        "Azure",
      );
      if (warning) {
        getLogger().warning(warning);
      }

      const session = await createAzureStreamingSession({
        subscriptionKey: this.subscriptionKey,
        region: this.region,
        sampleRate: outputRate,
        language,
        phrases,
        signal: startupAbort.signal,
      });
      if (!this.adoptStreamSession(generation, session)) return;
      this.resampler = resampler;
      getLogger().verbose("[Azure] Streaming session started successfully");
    } catch {
      if (!this.ownsStreamStartup(generation)) return;
      getLogger().error("[Azure] Failed to start streaming");
    }
  }

  writeAudioChunk(chunk: Float32Array): void {
    if (!this.resampler || !this.streamSession) return;
    const output = this.resampler.process(chunk);
    if (output.length) {
      if (!this.streamSession.writeAudioChunk)
        throw new Error("Azure streaming audio sink is unavailable");
      this.streamSession.writeAudioChunk(output);
    }
  }

  finalize(audio: StopRecordingResponse): Promise<TranscriptionSessionResult> {
    if (this.finalization) return this.finalization;
    if (audio.captureFailed) {
      this.cleanup();
      this.finalization = Promise.resolve(failedCaptureResult());
      return this.finalization;
    }
    const generation = this.startupGeneration;
    const stream = this.streamSession;
    const resampler = this.resampler;
    this.resampler = null;
    this.finalization = Promise.resolve().then(() => {
      if (!this.ownsStreamStartup(generation) || this.streamSession !== stream)
        return this.notEstablishedResult();
      const tail = resampler?.flush();
      if (tail?.length) {
        if (!stream?.writeAudioChunk)
          throw new Error("Azure streaming audio sink is unavailable");
        stream.writeAudioChunk(tail);
      }
      return super.finalize(audio);
    });
    return this.finalization;
  }

  cleanup(): void {
    const startupAbort = this.startupAbort;
    this.startupAbort = null;
    this.resampler?.reset();
    this.resampler = null;
    this.finalization = null;
    startupAbort?.abort();
    super.cleanup();
  }

  supportsStreaming(): boolean {
    return false;
  }
}
