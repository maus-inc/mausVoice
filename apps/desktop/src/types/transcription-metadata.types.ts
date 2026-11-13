import type { PostProcessingRunMode, TranscriptionMode } from "./ai.types";

/**
 * What a transcription or post-processing pass recorded about itself.
 *
 * These live in `types/` rather than beside the action that produces them
 * because the session types, the strategies and the repositories all describe a
 * result, and importing the description from an action module made
 * `types/transcription-session.types.ts` and `actions/transcribe.actions.ts`
 * import each other. The action module re-exports both, so every existing
 * importer keeps working.
 */
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
  /** True when the provider returned an edit that could not be applied. */
  postProcessEditFailed?: boolean | null;
  /** Number of edit-application failures in this transcription retry chain. */
  postProcessEditFailureCount?: number | null;
  /** True after the one automatic full-audio retranscription was consumed. */
  postProcessEditAutoRetryUsed?: boolean | null;
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
