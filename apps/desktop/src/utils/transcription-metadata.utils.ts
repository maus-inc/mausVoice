import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../types/transcription-metadata.types";
import { orNull } from "./nullable.utils";

/** Combine the provider's metadata with the settings and timing of this request. */
export const buildTranscriptionMetadata = ({
  provider,
  modelSize,
  durationMs,
  prompt,
  apiKeyId,
}: {
  provider: TranscribeAudioMetadata | null | undefined;
  modelSize: string | null | undefined;
  durationMs: number;
  prompt: string;
  apiKeyId: string | null;
}): TranscribeAudioMetadata => ({
  modelSize: provider?.modelSize || modelSize || null,
  inferenceDevice: provider?.inferenceDevice || null,
  transcriptionDurationMs: Math.round(durationMs),
  transcriptionPrompt: prompt,
  transcriptionApiKeyId: apiKeyId,
  transcriptionMode: provider?.transcriptionMode || null,
});

/** Normalize provider metadata for the durable and memory-only history rows. */
export const toTranscriptionRecordMetadata = (
  transcription: TranscribeAudioMetadata | null | undefined,
  postProcess: PostProcessMetadata | null | undefined,
) => {
  const source = transcription ?? {};
  const style = postProcess ?? {};
  return {
    modelSize: orNull(source.modelSize),
    inferenceDevice: orNull(source.inferenceDevice),
    transcriptionPrompt: orNull(source.transcriptionPrompt),
    transcriptionApiKeyId: orNull(source.transcriptionApiKeyId),
    transcriptionMode: orNull(source.transcriptionMode),
    transcriptionDurationMs: orNull(source.transcriptionDurationMs),
    postProcessPrompt: orNull(style.postProcessPrompt),
    postProcessApiKeyId: orNull(style.postProcessApiKeyId),
    postProcessMode: orNull(style.postProcessMode),
    postProcessDevice: orNull(style.postProcessDevice),
    postProcessModel: orNull(style.postProcessModel),
    postProcessProvider: orNull(style.postProcessProvider),
    postProcessFailed: orNull(style.postProcessFailed),
    postProcessFallback: orNull(style.postProcessFallback),
    postProcessError: orNull(style.postProcessError),
    postprocessDurationMs: orNull(style.postprocessDurationMs),
  };
};
