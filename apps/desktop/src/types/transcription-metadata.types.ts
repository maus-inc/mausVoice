import type { PostProcessingRunMode, TranscriptionMode } from "./ai.types";

export type TranscribeAudioMetadata = {
  modelSize?: string | null;
  inferenceDevice?: string | null;
  transcriptionPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  transcriptionDurationMs?: number | null;
};

export type PostProcessMetadata = {
  postProcessPrompt?: string | null;
  postProcessApiKeyId?: string | null;
  postProcessProvider?: string | null;
  postProcessMode?: PostProcessingRunMode | null;
  postProcessDevice?: string | null;
  /** Resolved model id used for post-processing (e.g. "openai/gpt-oss-20b"). */
  postProcessModel?: string | null;
  postprocessDurationMs?: number | null;
  /** True when a post-processing request was attempted and failed. */
  postProcessFailed?: boolean | null;
  /**
   * True when post-processing failed and the deterministic local style produced
   * the output instead. The transcript is still delivered; this marks the row
   * as degraded so the UI can say so.
   */
  postProcessFallback?: boolean | null;
  /** Sanitized, non-secret error message from a failed post-processing request. */
  postProcessError?: string | null;
  /**
   * Characters the fast local style path dropped from the end of an
   * over-length dictation, or null when nothing was dropped. The durable
   * record is the localized warning in `warnings`; this is the in-memory
   * signal the post-processing callers branch on.
   */
  fastStyleTruncatedChars?: number | null;
};
