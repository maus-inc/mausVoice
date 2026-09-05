import { Nullable } from "@maus-inc/types";
import { batchAsync } from "@maus-inc/utilities";
import {
  aldeaTranscribeAudio,
  assemblyaiTranscribeAudio,
  azureTranscribeAudio,
  type CustomFetch,
  deepgramTranscribeAudio,
  elevenlabsTranscribeAudio,
  geminiTranscribeAudio,
  GeminiTranscriptionModel,
  GEMINI_TRANSCRIPTION_MODELS,
  gladiaTranscribeAudio,
  type GladiaCustomizations,
  groqTranscribeAudio,
  normalizeAssemblyAISpeechModel,
  openaiTranscribeAudio,
  OpenAITranscriptionModel,
  openrouterTranscribeAudio,
  TranscriptionModel,
  xaiTranscribeAudio,
} from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import { DEFAULT_MODEL_SIZE, TranscriptionMode } from "../types/ai.types";
import { AudioSamples } from "../types/audio.types";
import { buildWaveFile } from "../utils/audio.utils";
import { analyzeSilence } from "../utils/audio-energy.utils";
import { getLocalTranscriptionSidecarManager } from "../sidecars";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  type LocalWhisperModel,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { openaiCompatibleTranscribeAudio } from "../utils/openai-compatible-transcribe.utils";
import {
  gateSilentSegments,
  type TranscriptionSegment,
} from "../utils/hallucination.utils";
import {
  createOpenAICompatibleFetch,
  secureFetch,
} from "../utils/secure-fetch.utils";
import { speachesTranscribeAudio } from "../utils/speaches.utils";
import {
  mergeTranscriptions,
  splitAudioTranscription,
} from "../utils/transcribe.utils";
import { BaseRepo } from "./base.repo";

type TranscriptionOptionsPayload = {
  model: LocalWhisperModel;
  preferGpu: boolean;
  deviceId?: string;
  hallucinationFilterEnabled: boolean;
};

export type TranscribeAudioMetadata = {
  inferenceDevice?: Nullable<string>;
  modelSize?: Nullable<string>;
  transcriptionMode?: Nullable<TranscriptionMode>;
};

export type TranscribeAudioInput = {
  samples: AudioSamples;
  sampleRate: number;
  prompt?: Nullable<string>;
  language?: string;
  /**
   * When false, the probability-gated silence handling is skipped entirely so
   * the raw provider transcript is preserved EXACTLY, for both single- and
   * multi-chunk audio. Defaults to true when omitted.
   */
  hallucinationFilterEnabled?: boolean;
};

export type TranscribeAudioOutput = {
  text: string;
  metadata?: Nullable<TranscribeAudioMetadata>;
  warnings?: string[];
  /** Verbose Whisper segments (with `no_speech_prob`) when the provider returns them. */
  segments?: TranscriptionSegment[];
};

export type TranscribeSegmentInput = {
  samples: Float32Array;
  sampleRate: number;
  prompt?: Nullable<string>;
  language?: string;
};

export type LocalTranscriptionSegment = {
  text: string;
  noSpeechProb: number;
};

export const NO_SPEECH_PROB_THRESHOLD = 0.6;

const HALLUCINATION_PHRASES = new Set(["thank you", "thanks", "you"]);
const TRAILING_PUNCTUATION = "!.?,";

const stripTrailingPunctuation = (value: string): string => {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(value[end - 1] ?? "")) {
    end -= 1;
  }
  return value.slice(0, end);
};

const isHallucinationText = (text: string): boolean => {
  const normalized = stripTrailingPunctuation(text.trim().toLowerCase());
  if (normalized.length === 0) {
    return true;
  }
  return HALLUCINATION_PHRASES.has(normalized);
};

export const filterLocalTranscriptionSegments = (
  segments: readonly LocalTranscriptionSegment[],
): string => {
  return segments
    .filter((segment) => {
      if (segment.noSpeechProb <= NO_SPEECH_PROB_THRESHOLD) {
        return true;
      }
      return !isHallucinationText(segment.text);
    })
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join(" ");
};

export abstract class BaseTranscribeAudioRepo extends BaseRepo {
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected abstract transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput>;

  /**
   * Energy-based silence gate. Returns true when the samples are
   * near-silent (low RMS, low loudest-window energy, and low peak), so
   * a cloud provider cannot echo its dictionary/glossary prompt back as
   * a fake transcript. Logs the decision with the scope ("whole clip"
   * or "chunk") for diagnostics.
   */
  protected isNearSilent(
    samples: Float32Array,
    sampleRate: number,
    scope: string,
  ): boolean {
    const silence = analyzeSilence(samples, sampleRate);
    if (silence.silent) {
      getLogger().info(
        `Skipping transcription (${scope}): audio is near-silent (rms=${silence.rms.toExponential(2)}, peak=${silence.peak.toExponential(2)}, maxWindowRms=${silence.maxWindowRms.toExponential(2)})`,
      );
    }
    return silence.silent;
  }

  /**
   * Transcribes audio, automatically splitting long audio into segments
   * and merging the results.
   */
  async transcribeAudio(
    input: TranscribeAudioInput,
  ): Promise<TranscribeAudioOutput> {
    // Keep one defensive Float32 copy without routing typed input through a
    // temporary number[]; hour-long provider chunks make that extra allocation
    // prohibitively expensive.
    const floatSamples =
      input.samples instanceof Float32Array
        ? input.samples.slice()
        : Float32Array.from(input.samples ?? []);

    if (floatSamples.length === 0) {
      return { text: "", metadata: null };
    }

    // Energy-based silence gate. Cloud providers (Gemini, Groq, OpenAI) are
    // biased by their prompt, which for us contains the user's dictionary:
    // on near-silent audio they return those glossary words instead of an
    // empty transcript. This is provider- and language-independent, unlike
    // `no_speech_prob` (which only some Whisper endpoints return). When the
    // filter is disabled the user wants the raw transcript, so skip it.
    const filterEnabled = input.hallucinationFilterEnabled ?? true;
    if (
      filterEnabled &&
      this.isNearSilent(floatSamples, input.sampleRate, "whole clip")
    ) {
      return { text: "", metadata: { transcriptionMode: "api" } };
    }

    const segmentDurationSec = this.getSegmentDurationSec();
    const segmentSampleCount = Math.floor(
      input.sampleRate * segmentDurationSec,
    );

    // If audio fits in a single segment, transcribe directly
    if (floatSamples.length <= segmentSampleCount) {
      return this.transcribeSegment({
        samples: floatSamples,
        sampleRate: input.sampleRate,
        prompt: input.prompt,
        language: input.language,
      });
    }

    // Split into overlapping segments
    const segments = splitAudioTranscription({
      sampleRate: input.sampleRate,
      samples: floatSamples,
      segmentDurationSec,
      overlapDurationSec: this.getOverlapDurationSec(),
    });

    // Create promise factories for batched execution. Skip chunks that are
    // near-silent so their glossary-prompt bias cannot produce a dictionary
    // hallucination (and so we don't pay to transcribe room noise).
    const transcriptionTasks = segments.map((segmentSamples) => () => {
      if (
        filterEnabled &&
        this.isNearSilent(segmentSamples, input.sampleRate, "chunk")
      ) {
        return Promise.resolve({ text: "", metadata: null });
      }
      return this.transcribeSegment({
        samples: segmentSamples,
        sampleRate: input.sampleRate,
        prompt: input.prompt,
        language: input.language,
      });
    });

    // Execute in batches
    const results = await batchAsync(
      this.getBatchChunkCount(),
      transcriptionTasks,
    );

    // Gate each provider chunk by its `no_speech_prob` segments BEFORE merging,
    // so audio longer than one provider segment still benefits from the
    // probability-gated silence handling that single-segment audio gets in the
    // action layer. Chunks without verbose segments fall back to their raw text.
    // When the user disables the filter, merge every raw chunk text unchanged so
    // the off switch preserves the provider transcript for long audio too.
    const transcriptionTexts = results.map((r) => {
      const gated = filterEnabled ? gateSilentSegments(r.segments) : null;
      return gated ?? r.text;
    });
    const mergedText = mergeTranscriptions(transcriptionTexts);

    // Use metadata from first result (all segments use same provider/device)
    const metadata = results[0]?.metadata ?? null;

    return {
      text: mergedText,
      metadata,
      warnings: Array.from(
        new Set(results.flatMap((result) => result.warnings ?? [])),
      ),
      // Do not flatten overlapping chunk segments: a later join would undo
      // mergeTranscriptions() and reintroduce duplicated overlap words.
    };
  }
}

export class LocalTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  // Local inference is single-threaded, process one at a time
  protected getBatchChunkCount(): number {
    return 1;
  }

  private resolveTranscriptionOptions(): TranscriptionOptionsPayload {
    const state = getAppState();
    const { device, modelSize } = state.settings.aiTranscription;
    getLogger().info("transcribing with", device, modelSize);

    return {
      model: normalizeLocalWhisperModel(modelSize || DEFAULT_MODEL_SIZE),
      preferGpu: isGpuPreferredTranscriptionDevice(device),
      deviceId: getTranscriptionSidecarDeviceId(device),
      hallucinationFilterEnabled:
        state.userPrefs?.hallucinationFilterEnabled !== false,
    };
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const options = this.resolveTranscriptionOptions();
    const sidecarManager = getLocalTranscriptionSidecarManager();
    const output = await sidecarManager.transcribe({
      model: options.model,
      preferGpu: options.preferGpu,
      samples: input.samples,
      sampleRate: input.sampleRate,
      initialPrompt: input.prompt ?? undefined,
      language: input.language,
      deviceId: options.deviceId,
      hallucinationFilterEnabled: options.hallucinationFilterEnabled,
    });

    return {
      text: output.text,
      metadata: {
        inferenceDevice: output.inferenceDevice,
        modelSize: output.model,
        transcriptionMode: "local",
      },
    };
  }
}

export class GroqTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private groqApiKey: string;
  private model: TranscriptionModel;
  private customFetch?: CustomFetch;

  constructor(
    apiKey: string,
    model: string | null,
    customFetch: CustomFetch | null = secureFetch,
  ) {
    super();
    this.groqApiKey = apiKey;
    this.model = (model as TranscriptionModel) ?? "whisper-large-v3-turbo";
    this.customFetch = customFetch ?? undefined;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript, segments } = await groqTranscribeAudio({
      apiKey: this.groqApiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
      customFetch: this.customFetch,
    });

    return {
      text: transcript,
      segments: segments?.map((segment) => ({
        text: segment.text,
        noSpeechProb: segment.noSpeechProb,
      })),
      metadata: {
        inferenceDevice: "API • Groq",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class OpenAITranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private openaiApiKey: string;
  private model: OpenAITranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.openaiApiKey = apiKey;
    this.model = model ?? "whisper-1";
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript, segments } = await openaiTranscribeAudio({
      apiKey: this.openaiApiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
      customFetch: secureFetch,
    });

    return {
      text: transcript,
      segments: segments?.map((segment) => ({
        text: segment.text,
        noSpeechProb: segment.noSpeechProb,
      })),
      metadata: {
        inferenceDevice: "API • OpenAI",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class AldeaTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private aldeaApiKey: string;

  constructor(apiKey: string) {
    super();
    this.aldeaApiKey = apiKey;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await aldeaTranscribeAudio({
      apiKey: this.aldeaApiKey,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Aldea",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class AssemblyAITranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private readonly apiKey: string;
  private readonly model: string | null;
  private readonly customFetch: typeof secureFetch;

  constructor(
    apiKey: string,
    model: string | null,
    customFetch: typeof secureFetch = secureFetch,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.customFetch = customFetch;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await assemblyaiTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      language: input.language,
      customFetch: this.customFetch,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • AssemblyAI",
        modelSize: normalizeAssemblyAISpeechModel(this.model) ?? null,
        transcriptionMode: "api",
      },
    };
  }
}

export class ElevenLabsTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await elevenlabsTranscribeAudio({
      apiKey: this.apiKey,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
      customFetch: secureFetch,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • ElevenLabs",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class DeepgramTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;
  private model: string;
  private customFetch: typeof secureFetch;

  constructor(
    apiKey: string,
    model: string | null,
    customFetch: typeof secureFetch = secureFetch,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? "nova-3";
    this.customFetch = customFetch;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await deepgramTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
      customFetch: this.customFetch,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Deepgram",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class GladiaTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly customizations: GladiaCustomizations;

  constructor(
    apiKey: string,
    model: string | null,
    customizations: GladiaCustomizations,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? "solaria-1";
    this.customizations = customizations;
  }

  protected override getSegmentDurationSec(): number {
    return 600;
  }

  protected override getBatchChunkCount(): number {
    return 1;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);
    const { text, warnings } = await gladiaTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      language: input.language ?? "auto",
      customizations: this.customizations,
    });

    return {
      text,
      warnings,
      metadata: {
        inferenceDevice: "API • Gladia",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class XaiTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await xaiTranscribeAudio({
      apiKey: this.apiKey,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
      customFetch: secureFetch,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Grok",
        modelSize: "xAI Speech to Text",
        transcriptionMode: "api",
      },
    };
  }
}

export class AzureTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private azureSubscriptionKey: string;
  private azureRegion: string;

  constructor(subscriptionKey: string, region: string) {
    super();
    this.azureSubscriptionKey = subscriptionKey;
    this.azureRegion = region;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await azureTranscribeAudio({
      subscriptionKey: this.azureSubscriptionKey,
      region: this.azureRegion,
      blob: wavBuffer,
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Azure",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class GeminiTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private geminiApiKey: string;
  private model: GeminiTranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.geminiApiKey = apiKey;
    this.model = model ?? GEMINI_TRANSCRIPTION_MODELS[0];
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await geminiTranscribeAudio({
      apiKey: this.geminiApiKey,
      model: this.model,
      blob: wavBuffer,
      mimeType: "audio/wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
      customFetch: secureFetch,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Gemini",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class SpeachesTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await speachesTranscribeAudio({
      baseUrl: this.baseUrl,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Speaches",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class OpenAICompatibleTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private customFetch: typeof secureFetch;

  constructor(
    apiKeyId: string,
    baseUrl: string,
    model: string,
    apiKey?: string,
  ) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
    this.customFetch = createOpenAICompatibleFetch(apiKeyId);
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript, segments } =
      await openaiCompatibleTranscribeAudio({
        baseUrl: this.baseUrl,
        model: this.model,
        apiKey: this.apiKey,
        blob: wavBuffer,
        ext: "wav",
        prompt: input.prompt ?? undefined,
        language: input.language,
        customFetch: this.customFetch,
      });

    return {
      text: transcript,
      segments: segments?.map((segment) => ({
        text: segment.text,
        noSpeechProb: segment.noSpeechProb,
      })),
      metadata: {
        inferenceDevice: "API • OpenAI Compatible",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class OpenRouterTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? "openai/whisper-large-v3";
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);
    const { text: transcript } = await openrouterTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • OpenRouter",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}
