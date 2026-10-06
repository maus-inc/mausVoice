import { PostProcessingRunMode, TranscriptionMode } from "./common.types";

export type Transcription = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  transcript: string;
  isDeleted: boolean;
  audio?: TranscriptionAudioSnapshot;
  modelSize?: string | null;
  inferenceDevice?: string | null;
  rawTranscript?: string | null;
  sanitizedTranscript?: string | null;
  transcriptionPrompt?: string | null;
  postProcessPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  postProcessApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  postProcessMode?: PostProcessingRunMode | null;
  postProcessDevice?: string | null;
  postProcessModel?: string | null;
  postProcessProvider?: string | null;
  postProcessFailed?: boolean | null;
  postProcessEditFailed?: boolean | null;
  postProcessEditFailureCount?: number | null;
  postProcessEditAutoRetryUsed?: boolean | null;
  postProcessFallback?: boolean | null;
  postProcessError?: string | null;
  transcriptionDurationMs?: number | null;
  postprocessDurationMs?: number | null;
  warnings?: string[] | null;
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
};

export type TranscriptionAudioSnapshot = {
  filePath: string;
  durationMs: number;
};
