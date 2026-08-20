import { Nullable } from "@maus-inc/types";
import { batchAsync } from "@maus-inc/utilities";
import {
  aldeaTranscribeAudio,
  assemblyaiTranscribeAudio,
  azureTranscribeAudio,
  deepgramTranscribeAudio,
  elevenlabsTranscribeAudio,
  geminiTranscribeAudio,
  GeminiTranscriptionModel,
  gladiaTranscribeAudio,
  type GladiaCustomizations,
  groqTranscribeAudio,
  openaiTranscribeAudio,
  OpenAITranscriptionModel,
  TranscriptionModel,
  xaiTranscribeAudio,
  XaiTranscriptionModel,
} from "@maus-inc/voice-ai";
import { getAppState } from "../store";
import { DEFAULT_MODEL_SIZE, TranscriptionMode } from "../types/ai.types";
import { AudioSamples } from "../types/audio.types";
import { buildWaveFile } from "../utils/audio.utils";
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

export abstract class BaseTranscribeAudioRepo extends BaseRepo {
  /**
   * Maximum duration in seconds for a single audio segment.
   * Override in child classes based on provider limits.
   */
  protected abstract getSegmentDurationSec(): number;

  /**
   * Overlap duration in seconds between consecutive segments.
   * Helps ensure transcription continuity at segment boundaries.
   */
  protected abstract getOverlapDurationSec(): number;

  /**
   * Number of concurrent transcription requests to run.
   * API providers may allow more parallelism, local inference typically 1.
   */
  protected abstract getBatchChunkCount(): number;

  /**
   * Internal method to transcribe a single audio segment.
   * Implemented by child classes with provider-specific logic.
   */
  protected abstract transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput>;

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

    // Create promise factories for batched execution
    const transcriptionTasks = segments.map(
      (segmentSamples) => () =>
        this.transcribeSegment({
          samples: segmentSamples,
          sampleRate: input.sampleRate,
          prompt: input.prompt,
          language: input.language,
        }),
    );

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
    const filterEnabled = input.hallucinationFilterEnabled ?? true;
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
  // Local whisper can handle longer segments, but 60s is a safe default
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

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

  constructor(apiKey: string, model: string | null) {
    super();
    this.groqApiKey = apiKey;
    this.model = (model as TranscriptionModel) ?? "whisper-large-v3-turbo";
  }

  // Groq has 25MB limit, 60s segments are well within that
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Groq can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
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
    this.model = (model as OpenAITranscriptionModel) ?? "whisper-1";
  }

  // OpenAI has 25MB limit, 60s segments are well within that
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // OpenAI can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
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

  // Conservative segment duration for Aldea
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Allow some parallelism for API requests
  protected getBatchChunkCount(): number {
    return 3;
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

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  // AssemblyAI batch transcripts accept far longer audio, but 60s keeps the
  // retranscribe path consistent with the other batch providers. The
  // assemblyaiTranscribeAudio() polling budget (180s default) and 3s poll
  // interval assume ~60s segments — revisit both together if this changes.
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await assemblyaiTranscribeAudio({
      apiKey: this.apiKey,
      blob: wavBuffer,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • AssemblyAI",
        modelSize: null,
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

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
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

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? "nova-3";
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
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

  protected getSegmentDurationSec(): number {
    return 10 * 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
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
  private model: XaiTranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as XaiTranscriptionModel) ?? "grok-stt";
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await xaiTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Grok",
        modelSize: this.model,
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

  // Azure supports up to 30MB, 60s segments are safe
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Azure can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
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
    this.model = (model as GeminiTranscriptionModel) ?? "gemini-2.5-flash";
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
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

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
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

  constructor(baseUrl: string, model: string, apiKey?: string) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
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
