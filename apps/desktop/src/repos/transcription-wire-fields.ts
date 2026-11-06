import type { Transcription } from "@maus-inc/types";
import { orNull } from "../utils/nullable.utils";

/** Shared optional wire fields for native storage and the browser preview. */
export const transcriptionWireFields = (transcription: Transcription) => ({
  modelSize: orNull(transcription.modelSize),
  inferenceDevice: orNull(transcription.inferenceDevice),
  rawTranscript: orNull(transcription.rawTranscript),
  sanitizedTranscript: orNull(transcription.sanitizedTranscript),
  transcriptionPrompt: orNull(transcription.transcriptionPrompt),
  postProcessPrompt: orNull(transcription.postProcessPrompt),
  transcriptionApiKeyId: orNull(transcription.transcriptionApiKeyId),
  postProcessApiKeyId: orNull(transcription.postProcessApiKeyId),
  transcriptionMode: orNull(transcription.transcriptionMode),
  postProcessMode: orNull(transcription.postProcessMode),
  postProcessDevice: orNull(transcription.postProcessDevice),
  postProcessModel: orNull(transcription.postProcessModel),
  postProcessProvider: orNull(transcription.postProcessProvider),
  postProcessFailed: orNull(transcription.postProcessFailed),
  postProcessFallback: orNull(transcription.postProcessFallback),
  postProcessError: orNull(transcription.postProcessError),
  transcriptionDurationMs: orNull(transcription.transcriptionDurationMs),
  postprocessDurationMs: orNull(transcription.postprocessDurationMs),
  warnings: orNull(transcription.warnings),
  remoteStatus: orNull(transcription.remoteStatus),
  remoteDeviceId: orNull(transcription.remoteDeviceId),
});
