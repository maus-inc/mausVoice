import { invoke } from "@tauri-apps/api/core";
import {
  Nullable,
  Transcription,
  TranscriptionAudioSnapshot,
} from "@maus-inc/types";
import { countWords, dedup, unknownToMessage } from "@maus-inc/utilities";
import dayjs from "dayjs";
import {
  getGenerateTextRepo,
  getTranscribeAudioRepo,
  getTranscriptionRepo,
} from "../repos";
import type { GenerateTextOutput } from "../repos/generate-text.repo";
import { TranscribeAudioOutput } from "../repos/transcribe-audio.repo";
import type { AppState } from "../state/app.state";
import { getAppState, produceAppState } from "../store";
import { classifyPostProcessErrorCategory } from "./post-process-error-category";
import { PostProcessingRunMode, TranscriptionMode } from "../types/ai.types";
import { AudioSamples } from "../types/audio.types";
import { StopRecordingResponse } from "../types/transcription-session.types";
import { resolveProcessedTranscription } from "../utils/ai.utils";
import { createId } from "../utils/id.utils";
import {
  isEphemeralSessionActive,
  isPersistenceAllowed,
} from "../utils/incognito.utils";
import {
  coerceToDictationLanguage,
  mapDictationLanguageToWhisperLanguage,
} from "../utils/language.utils";
import { orFalse, orNull } from "../utils/nullable.utils";
import { withTimeout } from "../utils/timeout.utils";
import { getLogger } from "../utils/log.utils";
import {
  appendTimingSample,
  markPipeline,
  summarizePipeline,
  type PipelineTrace,
} from "../utils/pipeline-trace";
import {
  buildLocalizedTranscriptionPrompt,
  buildPostProcessingPrompt,
  isGlossaryPromptTruncated,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
  PostProcessingPromptInput,
  PROCESSED_TRANSCRIPTION_JSON_RESPONSE,
  getPostProcessMaxTokens,
  POST_PROCESS_REASONING_EFFORT,
} from "../utils/prompt.utils";
import {
  applyHallucinationFiltering,
  type TranscriptionSegment,
} from "../utils/hallucination.utils";
import { getToneById, getToneConfig } from "../utils/tone.utils";
import {
  getMyEffectiveUserId,
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";
import {
  measureFastStyleTruncation,
  applyFastStyle,
  canApplyFastStyle,
} from "../utils/fast-style.utils";
import { getIntl } from "../i18n/intl";
import { showErrorSnackbar } from "./app.actions";
import { addWordsToCurrentUser } from "./user.actions";

export type TranscribeAudioInput = {
  samples: AudioSamples;
  sampleRate: number;
  dictationLanguage?: string;
  /** Preserve the recording's filter snapshot when retrying streamed audio. */
  hallucinationFilterEnabled?: boolean;
  trace?: PipelineTrace | null;
  /** Optional style id for fast transcription-time styling (no LLM). */
  toneId?: string | null;
  /** Cancels the provider request(s), e.g. when the dictation is cancelled. */
  signal?: AbortSignal;
};

export type TranscribeAudioMetadata = {
  modelSize?: string | null;
  inferenceDevice?: string | null;
  transcriptionPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  transcriptionDurationMs?: number | null;
};

export type TranscribeAudioResult = {
  /**
   * Provider output before replacements or hallucination filtering.
   *
   * Exact only when `hallucinationFilterEnabled` is false. With the filter on -- the
   * default -- this is `transcribeOutput.text.trim()`, so leading and trailing whitespace
   * is already gone before the segments are gated. An earlier version of this comment said
   * "exact" unconditionally, which read as a guarantee the default path does not keep.
   */
  rawTranscript: string;
  /** Text used by post-processing and output routing. */
  sanitizedTranscript: string;
  warnings: string[];
  metadata: TranscribeAudioMetadata;
  segments?: TranscriptionSegment[] | null;
};

export type PostProcessInput = {
  rawTranscript: string;
  toneId: Nullable<string>;
  dictationLanguage?: string;
  trace?: PipelineTrace | null;
  onPolishStart?: () => void;
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

export type PostProcessResult = {
  transcript: string;
  warnings: string[];
  metadata: PostProcessMetadata;
};

// Combined metadata type for storage compatibility
export type TranscriptionMetadata = TranscribeAudioMetadata &
  PostProcessMetadata & {
    rawTranscript?: string | null;
  };

/**
 * Transcribe audio samples to text.
 * This is the first step - just converts audio to raw transcript.
 */
export const transcribeAudio = async ({
  samples,
  sampleRate,
  dictationLanguage: dictationLanguageOverride,
  hallucinationFilterEnabled: filterOverride,
  trace,
  toneId,
  signal,
}: TranscribeAudioInput): Promise<TranscribeAudioResult> => {
  const state = getAppState();
  const hallucinationFilterEnabled =
    filterOverride ?? state.userPrefs?.hallucinationFilterEnabled ?? true;

  const metadata: TranscribeAudioMetadata = {};
  const warnings: string[] = [];

  const {
    repo: transcribeRepo,
    apiKeyId: transcriptionApiKeyId,
    warnings: transcribeWarnings,
  } = getTranscribeAudioRepo();
  warnings.push(...transcribeWarnings);

  // Dispatch warnings (e.g. a stale provider selection) must not be lost when
  // the transcription call itself throws: log them before the network call so
  // they always reach the log, and attach them to the thrown error below.
  if (warnings.length > 0) {
    getLogger().warning(`Transcription warnings: ${warnings.join("; ")}`);
  }

  const dictationLanguage = dictationLanguageOverride
    ? coerceToDictationLanguage(dictationLanguageOverride)
    : await loadMyEffectiveDictationLanguage(state);
  const whisperLanguage =
    mapDictationLanguageToWhisperLanguage(dictationLanguage);

  getLogger().verbose(
    `Transcribing audio: language=${dictationLanguage}, whisper=${whisperLanguage}, sampleRate=${sampleRate}, toneId=${toneId ?? "none"}`,
  );

  const dictionaryEntries = collectDictionaryEntries(state);
  // Best practice: transcription prompt is ONLY for glossary/domain bias (<50 tokens),
  // NOT for style formatting. Style is applied deterministically in fast-style.utils.ts
  // after transcription (universal across ALL providers).
  const transcriptionPrompt = buildLocalizedTranscriptionPrompt({
    entries: dictionaryEntries,
    dictationLanguage,
    state,
  });

  getLogger().verbose(
    `Transcription prompt: ${transcriptionPrompt.length} chars, apiKeyId=${transcriptionApiKeyId ?? "none"}`,
  );

  const transcribeStart = performance.now();
  let transcribeOutput: TranscribeAudioOutput;
  try {
    transcribeOutput = await transcribeRepo.transcribeAudio({
      samples,
      sampleRate,
      prompt: transcriptionPrompt,
      language: whisperLanguage,
      hallucinationFilterEnabled,
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep dispatch warnings visible on the failure path: the batch session
    // surfaces this message to the user, so append the warnings to it. The
    // original rejection is preserved verbatim as the cause, including
    // non-Error rejections.
    throw new Error(
      warnings.length > 0 ? `${message} (${warnings.join("; ")})` : message,
      { cause: error },
    );
  }
  const transcribeDuration = performance.now() - transcribeStart;
  warnings.push(...(transcribeOutput.warnings ?? []));
  if (transcribeOutput.warnings && transcribeOutput.warnings.length > 0) {
    getLogger().warning(
      `Provider transcription warnings: ${transcribeOutput.warnings.join("; ")}`,
    );
  }
  const rawTranscript = hallucinationFilterEnabled
    ? transcribeOutput.text.trim()
    : transcribeOutput.text;
  // Hallucination mitigation: when the user disables the filter we preserve the
  // raw provider transcript EXACTLY (no probability gating, no phrase
  // filtering). Otherwise we drop near-certain-silence segments via
  // `gateSilentSegments` and filter known silence phrases. Long audio that is
  // split into multiple provider chunks is gated per-chunk in the repo before
  // merging, so `transcribeOutput.segments` here covers the single-segment case
  // (and is undefined, triggering a fall back to the raw text, when the
  // provider returned no verbose segments).
  // Multi-chunk audio already gated and overlap-merged in the repo. Passing
  // flattened segments here would rebuild text and reintroduce overlap dupes.
  const sanitizedTranscript = applyHallucinationFiltering(
    rawTranscript,
    transcribeOutput.segments,
    dictationLanguage,
    hallucinationFilterEnabled,
  );

  if (rawTranscript !== sanitizedTranscript) {
    getLogger().info(
      "Removed a known silence hallucination from transcription",
    );
  }

  getLogger().info(
    `Transcription complete in ${Math.round(transcribeDuration)}ms (${rawTranscript.length} raw chars, ${sanitizedTranscript.length} sanitized chars, mode=${transcribeOutput.metadata?.transcriptionMode ?? "unknown"})`,
  );

  metadata.modelSize =
    transcribeOutput.metadata?.modelSize ||
    state.settings.aiTranscription.modelSize ||
    null;
  metadata.inferenceDevice = transcribeOutput.metadata?.inferenceDevice || null;
  metadata.transcriptionDurationMs = Math.round(transcribeDuration);
  metadata.transcriptionPrompt = transcriptionPrompt;
  metadata.transcriptionApiKeyId = transcriptionApiKeyId;
  metadata.transcriptionMode =
    transcribeOutput.metadata?.transcriptionMode || null;

  markPipeline(trace, "transcribed");

  return {
    rawTranscript,
    sanitizedTranscript,
    warnings: dedup(warnings),
    metadata,
    segments: transcribeOutput.segments ?? null,
  };
};

/**
 * Resolve the LLM's post-processing reply into the transcript to deliver.
 * Edits the model returns are applied against the raw transcript and
 * validated (see `resolveProcessedTranscription`); anything unusable falls
 * back to the raw transcript with a warning attached to the row.
 *
 * `unusable` is reported rather than folded into `warning` because the two
 * mean different things to the caller. A warning rides on text that was
 * delivered; an unusable reply means the provider answered with something that
 * produced no styling at all, so the transcript about to be stored is the raw
 * ASR. Retranscription keeps the row's existing polished text in that case
 * instead of overwriting it, and it can only do that if it is told.
 */
const resolvePostProcessedTranscript = (
  reply: string,
  rawTranscript: string,
): { transcript: string; warning: string | null; unusable: boolean } => {
  const resolution = resolveProcessedTranscription(reply, rawTranscript);
  if (resolution.status === "cleaned") {
    return {
      transcript: resolution.transcript,
      warning: resolution.warning,
      unusable: false,
    };
  }
  return {
    transcript: rawTranscript,
    warning: resolution.warning,
    unusable: true,
  };
};

type RunPostProcessingRequestArgs = {
  state: AppState;
  rawTranscript: string;
  toneId: Nullable<string>;
  toneName: Nullable<string>;
  dictationLanguageOverride?: string;
  genRepo: NonNullable<ReturnType<typeof getGenerateTextRepo>["repo"]>;
  genApiKeyId: Nullable<string>;
  genProvider: Nullable<string>;
  metadata: PostProcessMetadata;
  warnings: string[];
};

const fallbackValue = (value: Nullable<string>, fallback: string): string =>
  value ?? fallback;

const resolvePostProcessingLanguage = async (
  state: AppState,
  override?: string,
): Promise<string> =>
  override
    ? coerceToDictationLanguage(override)
    : await loadMyEffectiveDictationLanguage(state);

const buildPostProcessingRequest = (
  state: AppState,
  rawTranscript: string,
  toneId: Nullable<string>,
  dictationLanguage: string,
): { system: string; prompt: string; glossaryTruncated: boolean } => {
  const toneConfig = getToneConfig(state, toneId);
  const input: PostProcessingPromptInput = {
    transcript: rawTranscript,
    userName: getMyUserName(state),
    dictationLanguage,
    tone: toneConfig,
    // The exact-spelling instruction appended to every system prompt is only
    // meaningful when the cleanup model can see the dictionary contents.
    glossary: collectDictionaryEntries(state),
  };
  return {
    system: buildSystemPostProcessingTonePrompt(input),
    prompt: buildPostProcessingPrompt(input),
    glossaryTruncated: isGlossaryPromptTruncated(input.glossary),
  };
};

const applyPostProcessSuccess = (
  genOutput: GenerateTextOutput,
  processedTranscript: string,
  metadata: PostProcessMetadata,
  warnings: string[],
  postprocessStart: number,
): string => {
  const postprocessDuration = performance.now() - postprocessStart;
  metadata.postprocessDurationMs = Math.round(postprocessDuration);

  getLogger().info(
    `Post-processing complete in ${Math.round(postprocessDuration)}ms`,
  );
  getLogger().verbose("LLM raw output length:", genOutput.text.length);

  const parseResult = resolvePostProcessedTranscript(
    genOutput.text,
    processedTranscript,
  );
  const nextTranscript = parseResult.transcript;
  if (parseResult.warning) {
    getLogger().warning(parseResult.warning);
    warnings.push(parseResult.warning);
  } else {
    getLogger().verbose("Processed transcript length:", nextTranscript.length);
  }
  if (parseResult.unusable) {
    // The request succeeded, so `postProcessFailed` stays false and the reason
    // it was dropped rides on `warnings`. The row still has to be marked
    // degraded: the transcript being stored is the raw ASR, and a caller that
    // only reads the failure sentinel would treat this as a finished
    // retranscription and overwrite text the user already had polished.
    metadata.postProcessFallback = true;
  }

  metadata.postProcessMode =
    genOutput.metadata?.postProcessingMode || metadata.postProcessMode;
  metadata.postProcessDevice = genOutput.metadata?.inferenceDevice || null;
  metadata.postProcessModel = genOutput.metadata?.model || null;
  // Clear any prior failure flags so a successful run never leaves a
  // stale postProcessFailed=true on an updated row.
  metadata.postProcessFailed = false;
  metadata.postProcessError = null;
  getLogger().verbose(
    "Post-process mode:",
    metadata.postProcessMode,
    "device:",
    metadata.postProcessDevice,
    "model:",
    metadata.postProcessModel,
  );
  return nextTranscript;
};

export const redactTranscriptContent = (
  text: string,
  transcript?: string,
): string => {
  if (!transcript?.trim()) {
    return text;
  }
  const needle = transcript.trim();
  if (needle.length > 0 && text.includes(needle)) {
    return text.replaceAll(needle, "[REDACTED_TRANSCRIPT]");
  }
  return text;
};

const recordPostProcessFailure = (
  error: unknown,
  metadata: PostProcessMetadata,
  warnings: string[],
  postprocessStart: number,
  rawTranscript?: string,
): void => {
  const postprocessDuration = performance.now() - postprocessStart;
  metadata.postprocessDurationMs = Math.round(postprocessDuration);
  metadata.postProcessFailed = true;
  const rawMessage = unknownToMessage(error) || "Post-processing failed";
  const category = classifyPostProcessErrorCategory(rawMessage);
  const sanitizedMessage = redactTranscriptContent(rawMessage, rawTranscript);
  metadata.postProcessError = category;
  getLogger().error(
    `Post-processing request failed: [${category}] ${sanitizedMessage}`,
  );
  warnings.push(category);
};

/**
 * Deadline for one post-processing request. The dictation pipeline wraps
 * handleTranscript in a 60s budget (HANDLE_TRANSCRIPT_TIMEOUT_MS), so this
 * must stay below it: the inner timeout fires first, aborts the provider
 * request, and falls back to the raw transcript — the outer wrapper only
 * covers a case where even the failure handler hangs. Without this a hung
 * provider call kept running to completion in the background after the UI
 * had already moved on (the original AbortSignal path was dropped in the
 * 1.6 rebuild).
 */
const POST_PROCESS_TIMEOUT_MS = 50_000;

const beginPostProcessingRequest = ({
  metadata,
  toneName,
  genApiKeyId,
  genProvider,
}: {
  metadata: PostProcessMetadata;
  toneName: Nullable<string>;
  genApiKeyId: Nullable<string>;
  genProvider: Nullable<string>;
}): void => {
  getLogger().verbose(
    `Post-processing with tone=${fallbackValue(toneName, "default")}, provider=${fallbackValue(genProvider, "none")}, apiKeyId=${fallbackValue(genApiKeyId, "none")}`,
  );

  // Persist attribution BEFORE the network request so a 402, timeout, or
  // cancellation still records which provider was selected. We never reset
  // this to "none" on failure; that would hide the user's choice.
  metadata.postProcessApiKeyId = genApiKeyId;
  metadata.postProcessProvider = genProvider;
  metadata.postProcessMode = "api";
};

/**
 * Record that fast local styling dropped characters. Both fast-style call paths
 * route through here so the user-facing warning cannot drift from the cap that
 * actually truncated the text, and so neither path can truncate silently.
 */
const recordFastStyleTruncation = (
  rawTranscript: string,
  context: string,
  metadata: PostProcessMetadata,
  warnings: string[],
): void => {
  const truncation = measureFastStyleTruncation(rawTranscript);
  if (!truncation) return;
  getLogger().warning(
    `Fast style dropped ${truncation.droppedChars} chars for ${context} (kept ${truncation.keptChars} of ${rawTranscript.length})`,
  );
  metadata.fastStyleTruncatedChars = truncation.droppedChars;
  // Which sentence to use depends on whether anything was written.
  // `isPersistenceAllowed()` is false under incognito mode and during an
  // ephemeral session, and both store paths consult it before writing, so the
  // original unconditional "saved in History" pointed the user at a row that
  // was never created while the dropped tail was in fact unrecoverable.
  //
  // The no-persistence wording names History rather than dropping the word: the
  // user has just been told text went missing, and silence about where it went
  // reads as a bug. Saying History is unavailable is the actionable half, and
  // it matches the copy the review-persistence failure already uses.
  //
  // Two `formatMessage` calls rather than one call with a conditional
  // descriptor, because the extractor needs `id` and `defaultMessage` as string
  // literals in the argument and cannot follow a ternary. Both ids below are
  // the ones the extractor generates from these messages; see the note on the
  // explicit id for why they cannot be left implicit.
  warnings.push(
    isPersistenceAllowed()
      ? getIntl().formatMessage(
          {
            // Without an explicit id the descriptor cannot resolve: `intl.ts`
            // falls back to using the English default message as the id, and
            // the catalogs key on the id the extractor generates from that
            // message, so the lookup missed and every locale got the English
            // warning. Both ids below are those extractor-generated ids.
            id: "dictation_was_longer_than_fast_styling_allows_droppedchars_c",
            defaultMessage:
              "Dictation was longer than fast styling allows. {droppedChars} characters at the end were left unstyled. The full text is saved in History.",
          },
          { droppedChars: truncation.droppedChars },
        )
      : getIntl().formatMessage(
          {
            id: "history_is_not_available_in_this_session_so_the_droppedchars",
            defaultMessage:
              "History is not available in this session, so the {droppedChars} characters fast styling left unstyled at the end of that dictation were not saved.",
          },
          { droppedChars: truncation.droppedChars },
        ),
  );
};

/**
 * Deterministic local styling, shared by both fast paths: no LLM configured,
 * and the LLM path falling back after a provider failure. Records mode,
 * duration and any truncation, then returns the styled text, or null when the
 * tone has no local transform or the transform threw, so the caller keeps its
 * own behaviour.
 *
 * Deliberately does not touch postProcessProvider, postProcessApiKeyId or
 * postProcessModel. Those record which provider the user chose and which model
 * ran; a local transform used neither, and overwriting them would hide the
 * user's selection on a failed LLM call.
 *
 * Returns the styled text and its own duration, or null when the tone has no
 * local transform or the transform threw.
 */
export const applyFastLocalStyle = ({
  rawTranscript,
  toneId,
  metadata,
  warnings,
  reason,
}: {
  rawTranscript: string;
  toneId: Nullable<string>;
  metadata: PostProcessMetadata;
  warnings: string[];
  reason: "no-llm" | "llm-failed";
}): { styled: string; fastDurationMs: number } | null => {
  if (!canApplyFastStyle(toneId)) return null;

  const startedAt = performance.now();
  let styled: string;
  try {
    styled = applyFastStyle(rawTranscript, toneId ?? null);
  } catch (error) {
    getLogger().warning(
      `Fast local style failed for tone=${toneId}, reason=${reason}: ${error}`,
    );
    return null;
  }

  // Several transforms are subtractive rather than rewriting — the filler,
  // informal and contraction passes all delete matches. Filler-only input such
  // as "um uh er" therefore comes back empty, and returning that would hand the
  // caller a blank utterance: nothing is inserted, and because
  // `postProcessFailed` is untouched on this path no failure is reported either,
  // so the dictation disappears without a word. Treat an empty transform as "no
  // local style available" and let the caller fall back to the raw transcript.
  if (styled.trim().length === 0) {
    getLogger().warning(
      `Fast local style produced no output for tone=${toneId}, reason=${reason}; falling back to the raw transcript`,
    );
    return null;
  }

  const fastDurationMs = Math.round(performance.now() - startedAt);
  metadata.postProcessMode = "fast";
  metadata.postProcessModel = null;
  metadata.postprocessDurationMs = fastDurationMs;
  recordFastStyleTruncation(
    rawTranscript,
    `fast style tone=${toneId} reason=${reason}`,
    metadata,
    warnings,
  );
  getLogger().info(
    `Fast local style applied for tone=${toneId}, reason=${reason}, in ${fastDurationMs}ms`,
  );
  return { styled, fastDurationMs };
};

const runPostProcessingRequest = async ({
  state,
  rawTranscript,
  toneId,
  toneName,
  dictationLanguageOverride,
  genRepo,
  genApiKeyId,
  genProvider,
  metadata,
  warnings,
}: RunPostProcessingRequestArgs): Promise<string> => {
  beginPostProcessingRequest({
    metadata,
    toneName,
    genApiKeyId,
    genProvider,
  });

  const dictationLanguage = await resolvePostProcessingLanguage(
    state,
    dictationLanguageOverride,
  );
  const { system, prompt, glossaryTruncated } = buildPostProcessingRequest(
    state,
    rawTranscript,
    toneId,
    dictationLanguage,
  );
  if (glossaryTruncated) {
    warnings.push(
      "Some dictionary entries were omitted from the post-processing glossary because the safe prompt budget was reached.",
    );
  }
  metadata.postProcessPrompt = prompt;
  getLogger().verbose(
    "Post-process language:",
    dictationLanguage,
    "toneName:",
    fallbackValue(toneName, "unknown"),
  );
  getLogger().verbose(
    "Post-process prompt length:",
    prompt.length,
    "system length:",
    system.length,
  );

  const postprocessStart = performance.now();
  getLogger().verbose("Calling LLM for post-processing");
  const maxTokens = getPostProcessMaxTokens(rawTranscript);
  getLogger().verbose(`Post-processing budget: maxTokens=${maxTokens}`);
  const postProcessAbort = new AbortController();
  try {
    const genOutput = await withTimeout(
      genRepo.generateText({
        system,
        prompt,
        jsonResponse: PROCESSED_TRANSCRIPTION_JSON_RESPONSE,
        maxTokens,
        reasoningEffort: POST_PROCESS_REASONING_EFFORT,
        signal: postProcessAbort.signal,
      }),
      POST_PROCESS_TIMEOUT_MS,
      "Post-processing request",
      () => postProcessAbort.abort(),
    );
    return applyPostProcessSuccess(
      genOutput,
      rawTranscript,
      metadata,
      warnings,
      postprocessStart,
    );
  } catch (error) {
    // Terminal provider failure (e.g. Cerebras 402) or network error. Degrade
    // to the deterministic local style so the user still gets styled output,
    // then record the failure. The LLM call really did fail, so
    // postProcessFailed stays true and the error category is kept; only the
    // returned text comes from the local path.
    const fast = applyFastLocalStyle({
      rawTranscript,
      toneId,
      metadata,
      warnings,
      reason: "llm-failed",
    });
    if (fast !== null) {
      recordPostProcessFailure(
        error,
        metadata,
        warnings,
        postprocessStart,
        rawTranscript,
      );
      // The local transform produced usable output, so the transcript must
      // still be delivered. postProcessFailed gates insertion in the dictation
      // strategy, so leaving it true would send the styled text nowhere and
      // tell the user styling failed. The provider error is still recorded and
      // postProcessFallback marks the row as degraded.
      metadata.postProcessFailed = false;
      metadata.postProcessFallback = true;
      metadata.postprocessDurationMs = fast.fastDurationMs;
      warnings.push(
        "Fast local style applied instead of the LLM post-processor.",
      );
      return fast.styled;
    }

    // No fast fallback: return raw with failure metadata (dead-letter path)
    recordPostProcessFailure(
      error,
      metadata,
      warnings,
      postprocessStart,
      rawTranscript,
    );
    return rawTranscript;
  } finally {
    // `withTimeout` aborts a hung request, but a provider can also reject
    // before its network work has fully unwound. Always signal completion so
    // every adapter receives the same cancellation boundary on success and
    // failure, without leaving a request to consume quota after this turn.
    postProcessAbort.abort();
  }
};

const applyPostProcessing = async (
  { rawTranscript, toneId, dictationLanguage, onPolishStart }: PostProcessInput,
  state: AppState,
  gen: ReturnType<typeof getGenerateTextRepo>,
  metadata: PostProcessMetadata,
  warnings: string[],
): Promise<string> => {
  const tone = getToneById(state, toneId);
  if (tone?.shouldDisablePostProcessing) {
    getLogger().info(`Post-processing disabled for tone=${toneId}`);
    metadata.postProcessMode = "none";
    return rawTranscript;
  }
  if (!gen.repo) {
    const fast = applyFastLocalStyle({
      rawTranscript,
      toneId,
      metadata,
      warnings,
      reason: "no-llm",
    });
    if (fast !== null) {
      onPolishStart?.();
      return fast.styled;
    }
    getLogger().info("No post-processing repo configured, skipping");
    metadata.postProcessMode = "none";
    return rawTranscript;
  }
  onPolishStart?.();
  return await runPostProcessingRequest({
    state,
    rawTranscript,
    toneId,
    toneName: tone?.name ?? null,
    dictationLanguageOverride: dictationLanguage,
    genRepo: gen.repo,
    genApiKeyId: gen.apiKeyId,
    genProvider: gen.provider,
    metadata,
    warnings,
  });
};

export const postProcessTranscript = async (
  input: PostProcessInput,
): Promise<PostProcessResult> => {
  const state = getAppState();

  const metadata: PostProcessMetadata = {};
  const warnings: string[] = [];

  const gen = getGenerateTextRepo();
  warnings.push(...gen.warnings);

  const transcript = await applyPostProcessing(
    input,
    state,
    gen,
    metadata,
    warnings,
  );

  if (metadata.postProcessMode !== "none") {
    markPipeline(input.trace, "polished");
  }

  return {
    transcript,
    warnings: dedup(warnings),
    metadata,
  };
};

export type StoreTranscriptionInput = {
  audio: StopRecordingResponse;
  rawTranscript: string | null;
  sanitizedTranscript: string | null;
  transcript: string | null;
  transcriptionMetadata: TranscribeAudioMetadata;
  postProcessMetadata: PostProcessMetadata;
  warnings: string[];
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
  trace?: PipelineTrace | null;
};

export type StoreTranscriptionOutput = {
  transcription: Transcription | null;
  wordCount: number;
};

const getSampleCount = (samples: StopRecordingResponse["samples"]): number =>
  samples ? samples.length : 0;

const getWordsAdded = (transcript: string | null): number =>
  transcript ? countWords(transcript) : 0;

const recordUsageWords = async (wordsAdded: number): Promise<void> => {
  if (wordsAdded <= 0) {
    return;
  }
  try {
    await addWordsToCurrentUser(wordsAdded);
  } catch (error) {
    console.error("Failed to update usage metrics", error);
  }
};

const persistAudioSnapshot = async (
  transcriptionId: string,
  samples: number[] | Float32Array,
  sampleRate: number,
): Promise<TranscriptionAudioSnapshot | undefined> => {
  try {
    return await invoke<TranscriptionAudioSnapshot>(
      "store_transcription_audio",
      {
        id: transcriptionId,
        samples,
        sampleRate,
      },
    );
  } catch (error) {
    getLogger().error("Failed to persist audio snapshot", error);
    return undefined;
  }
};

const buildTranscriptionRecord = ({
  input,
  transcriptionId,
  audioSnapshot,
  transcriptionFailed,
  createdAt,
  createdByUserId,
}: {
  input: StoreTranscriptionInput;
  transcriptionId: string;
  audioSnapshot: TranscriptionAudioSnapshot | undefined;
  transcriptionFailed: boolean;
  createdAt: string;
  createdByUserId: string;
}): Transcription => ({
  id: transcriptionId,
  transcript: !transcriptionFailed
    ? (input.transcript ?? "")
    : "[Transcription Failed]",
  createdAt,
  createdByUserId,
  isDeleted: false,
  audio: audioSnapshot,
  modelSize: orNull(input.transcriptionMetadata.modelSize),
  inferenceDevice: orNull(input.transcriptionMetadata.inferenceDevice),
  rawTranscript: input.rawTranscript ?? input.transcript ?? "",
  sanitizedTranscript: orNull(input.sanitizedTranscript),
  transcriptionPrompt: orNull(input.transcriptionMetadata.transcriptionPrompt),
  postProcessPrompt: orNull(input.postProcessMetadata.postProcessPrompt),
  transcriptionApiKeyId: orNull(
    input.transcriptionMetadata.transcriptionApiKeyId,
  ),
  postProcessApiKeyId: orNull(input.postProcessMetadata.postProcessApiKeyId),
  transcriptionMode: orNull(input.transcriptionMetadata.transcriptionMode),
  postProcessMode: orNull(input.postProcessMetadata.postProcessMode),
  postProcessDevice: orNull(input.postProcessMetadata.postProcessDevice),
  postProcessModel: orNull(input.postProcessMetadata.postProcessModel),
  postProcessProvider: orNull(input.postProcessMetadata.postProcessProvider),
  postProcessFailed: input.postProcessMetadata.postProcessFailed ?? null,
  postProcessFallback: input.postProcessMetadata.postProcessFallback ?? null,
  postProcessError: orNull(input.postProcessMetadata.postProcessError),
  transcriptionDurationMs: orNull(
    input.transcriptionMetadata.transcriptionDurationMs,
  ),
  postprocessDurationMs: orNull(
    input.postProcessMetadata.postprocessDurationMs,
  ),
  warnings: input.warnings.length > 0 ? input.warnings : null,
  remoteStatus: orNull(input.remoteStatus),
  remoteDeviceId: orNull(input.remoteDeviceId),
});

const persistTranscription = async (
  transcription: Transcription,
): Promise<Transcription | null> => {
  try {
    const stored =
      await getTranscriptionRepo().createTranscription(transcription);
    produceAppState((draft) => {
      draft.transcriptionById[stored.id] = stored;
      const existingIds = draft.transcriptions.transcriptionIds.filter(
        (identifier) => identifier !== stored.id,
      );
      draft.transcriptions.transcriptionIds = [stored.id, ...existingIds];
    });
    return stored;
  } catch (error) {
    console.error("Failed to store transcription", error);
    showErrorSnackbar("Unable to save transcription. Please try again.");
    return null;
  }
};

const purgeStaleAudioSnapshots = async (): Promise<void> => {
  try {
    const purgedIds = await getTranscriptionRepo().purgeStaleAudio();
    if (purgedIds.length === 0) {
      return;
    }
    produceAppState((draft) => {
      for (const purgedId of purgedIds) {
        const purged = draft.transcriptionById[purgedId];
        if (purged) {
          delete purged.audio;
        }
      }
    });
  } catch (error) {
    console.error("Failed to purge stale audio snapshots", error);
  }
};

const shouldStoreRecording = (
  rate: number,
  sampleCount: number,
  hasText: boolean,
  transcriptionFailed: boolean,
): boolean => {
  if (rate <= 0 || sampleCount === 0) {
    if (hasText) {
      getLogger().warning(
        `Storing text record with empty audio (rate=${rate}, sampleCount=${sampleCount})`,
      );
    } else if (transcriptionFailed) {
      getLogger().warning(
        `Storing transcription-failure marker (rate=${rate}, sampleCount=${sampleCount})`,
      );
    } else {
      getLogger().warning(
        `Skipping store: rate=${rate}, sampleCount=${sampleCount}`,
      );
      return false;
    }
  }
  return true;
};

export const storeTranscription = async (
  input: StoreTranscriptionInput,
): Promise<StoreTranscriptionOutput> => {
  getLogger().verbose("Storing transcription record");
  const rate = input.audio.sampleRate;
  const sampleCount = getSampleCount(input.audio.samples);

  if (rate == null || !Number.isFinite(rate)) {
    getLogger().error("Received audio payload without sample rate");
    showErrorSnackbar("Recording missing sample rate. Please try again.");
    return { transcription: null, wordCount: 0 };
  }

  const hasText = Boolean(
    input.rawTranscript && input.rawTranscript.length > 0,
  );
  const transcriptionFailed =
    input.rawTranscript === null && input.warnings.length > 0;

  if (!shouldStoreRecording(rate, sampleCount, hasText, transcriptionFailed)) {
    return { transcription: null, wordCount: 0 };
  }

  const state = getAppState();
  const incognitoEnabled = orFalse(state.userPrefs?.incognitoModeEnabled);
  const includeInStats = orFalse(state.userPrefs?.incognitoModeIncludeInStats);
  const preserveAudioOnFailure =
    state.userPrefs?.preserveAudioOnFailure ?? true;
  const wordsAdded = getWordsAdded(input.transcript);
  const transcriptionId = createId();

  if (!isPersistenceAllowed()) {
    getLogger().verbose(
      `Persistence suppressed: skipping storage (incognito=${incognitoEnabled}, includeInStats=${includeInStats}, words=${wordsAdded})`,
    );
    // Counting words is an incognito-only option. An ephemeral session never
    // opted into usage statistics.
    //
    // `void`, not `await`, and for the same reason its non-incognito sibling is
    // `void`: the session stays locked until this function returns, so awaiting a
    // queued profile write holds the lock across an IPC and a pill click that lands
    // in the gap is accepted by the pill and then dropped by the app. Commit
    // 9a638fa40 applied that to the sibling and left this branch awaiting.
    // `recordUsageWords` owns its own error handling, so discarding the promise
    // cannot produce an unhandled rejection, and the cost of being late is one
    // dictation's word count.
    if (
      wordsAdded > 0 &&
      includeInStats &&
      incognitoEnabled &&
      !isEphemeralSessionActive()
    ) {
      void recordUsageWords(wordsAdded);
    }

    return { transcription: null, wordCount: wordsAdded };
  }

  // Skip the audio write entirely when the user has opted out of retaining
  // failed recordings, so we don't leak a WAV on disk with no DB pointer to
  // ever purge it from.
  const shouldPersistAudio =
    rate > 0 &&
    sampleCount > 0 &&
    !(transcriptionFailed && !preserveAudioOnFailure);
  const payloadSamples = Array.isArray(input.audio.samples)
    ? input.audio.samples
    : Array.from(input.audio.samples ?? []);
  const audioSnapshot = shouldPersistAudio
    ? await persistAudioSnapshot(transcriptionId, payloadSamples, rate)
    : undefined;

  const transcription = buildTranscriptionRecord({
    input,
    transcriptionId,
    audioSnapshot,
    transcriptionFailed,
    createdAt: dayjs().toISOString(),
    createdByUserId: getMyEffectiveUserId(state),
  });

  const storedTranscription = await persistTranscription(transcription);
  if (!storedTranscription) {
    if (audioSnapshot) {
      // Housekeeping, deliberately not awaited. The pill goes idle as soon as
      // the transcript is inserted, so it accepts clicks while the stop path is
      // still unwinding; a click in that gap is taken natively and then dropped.
      // A sweep that hangs would hold the session locked for as long as it
      // takes, so it runs on its own and the row is already durable.
      void purgeStaleAudioSnapshots();
    }
    return { transcription: null, wordCount: 0 };
  }

  // Usage metering and the audio retention sweep are housekeeping, not the save
  // the user is waiting on. The pill is already told to go idle by the time we
  // get here, so it looks clickable, but this session stays locked until the
  // stop path returns. Awaiting two slow calls here held that lock across a
  // queued profile write and a disk scan, so a click landing in that gap was
  // accepted by the pill and then dropped by the app. Both calls own their error
  // handling, and both are safe to land late: a missed word count is one
  // dictation of statistics, and a missed sweep runs again on the next one.
  void recordUsageWords(wordsAdded);
  void purgeStaleAudioSnapshots();

  markPipeline(input.trace, "persisted");
  const summary = summarizePipeline(input.trace);
  if (summary) {
    const providerKey = [
      input.transcriptionMetadata.transcriptionMode ?? "unknown",
      input.transcriptionMetadata.modelSize ?? "",
      input.transcriptionMetadata.inferenceDevice ?? "",
      input.postProcessMetadata.postProcessMode ?? "",
    ].join("|");
    produceAppState((draft) => {
      draft.local.providerTiming[providerKey] = appendTimingSample(
        draft.local.providerTiming[providerKey],
        summary,
      );
    });
  }

  return { transcription: storedTranscription, wordCount: wordsAdded };
};
