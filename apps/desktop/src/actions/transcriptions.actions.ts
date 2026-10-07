import { Transcription } from "@maus-inc/types";
import { delayed, getRec } from "@maus-inc/utilities";
import dayjs from "dayjs";
import { getIntl } from "../i18n/intl";
import { getTranscriptionRepo } from "../repos";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";
import { createId } from "../utils/id.utils";
import { orFalse } from "../utils/nullable.utils";
import { POST_PROCESS_TRUNCATED_WARNING } from "../utils/prompt.utils";
import {
  beginRetranscribe,
  clearRetranscribeSuccess,
  finishRetranscribe,
  isRetranscribingId,
  RETRANSCRIPTION_SUCCESS_VISIBLE_MS,
} from "../state/transcriptions.state";
import { getAppState, produceAppState } from "../store";
import { sanitizeTranscriptText } from "../utils/sanitize-transcript.utils";
import {
  getPostProcessEditRetranscribeDelayMs,
  POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER,
  shouldAutomaticallyRetranscribePostProcessEditFailure,
} from "../utils/post-process-retry.utils";
import type { ReplacementRule } from "../utils/string.utils";
import {
  getMyDictationLanguage,
  getMyEffectiveUserId,
  getMyUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar, showSnackbar } from "./app.actions";
import { postProcessErrorReason } from "./post-process-error-category";
import {
  dismissToast,
  runToast,
  showCompletionToast,
  showPersistentToast,
} from "./toast.actions";
import {
  postProcessTranscript,
  storeTranscription,
  transcribeAudio,
  type PostProcessMetadata,
} from "./transcribe.actions";

export const openTranscriptionDetailsDialog = (transcriptionId: string) => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogTranscriptionId = transcriptionId;
    draft.transcriptions.detailsDialogOpen = true;
  });
};

export const closeTranscriptionDetailsDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.detailsDialogOpen = false;
  });
};

export const openRetranscribeDialog = (transcriptionId: string) => {
  if (isRetranscribingId(getAppState().transcriptions, transcriptionId)) {
    return;
  }
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogTranscriptionId = transcriptionId;
    draft.transcriptions.retranscribeDialogOpen = true;
  });
};

export const closeRetranscribeDialog = () => {
  produceAppState((draft) => {
    draft.transcriptions.retranscribeDialogOpen = false;
  });
};

type ProcessAudioParams = {
  samples: number[] | Float32Array;
  sampleRate: number;
  toneId?: string | null;
  languageCode?: string | null;
  postProcessEditFailureCount?: number | null;
};

type ProcessedAudio = Awaited<ReturnType<typeof processAudio>>;

const getReplacementRules = (): ReplacementRule[] =>
  Object.values(getAppState().termById)
    .filter((term) => term.isReplacement)
    .map((term) => ({
      sourceValue: term.sourceValue,
      destinationValue: term.destinationValue,
    }));

const sanitizeImportedTranscript = (
  rawTranscript: string,
  languageCode?: string | null,
): string => {
  const state = getAppState();
  const prefs = getMyUserPreferences(state);
  return sanitizeTranscriptText({
    rawTranscript,
    replacementRules: getReplacementRules(),
    language: languageCode ?? getMyDictationLanguage(state),
    spokenCommandsEnabled: prefs?.spokenCommandsEnabled ?? true,
    hallucinationFilterEnabled: prefs?.hallucinationFilterEnabled ?? true,
  });
};

const processAudio = async ({
  samples,
  sampleRate,
  toneId,
  languageCode,
  postProcessEditFailureCount,
}: ProcessAudioParams) => {
  const transcribeResult = await transcribeAudio({
    samples,
    sampleRate,
    dictationLanguage: languageCode ?? undefined,
  });
  const sanitizedTranscript = sanitizeImportedTranscript(
    transcribeResult.sanitizedTranscript,
    languageCode,
  );
  const postProcessResult = await postProcessTranscript({
    rawTranscript: sanitizedTranscript,
    toneId: toneId ?? null,
    dictationLanguage: languageCode ?? undefined,
    postProcessEditFailureCount,
  });

  return { transcribeResult, sanitizedTranscript, postProcessResult };
};

type RetranscribeUpdate = {
  /** False when the run left the row without usable styling. */
  styled: boolean;
  /**
   * Why the row kept its previous text, phrased for the error surface. Null
   * on a styled run.
   */
  unstyledMessage: string | null;
  /**
   * The recorded reason behind `unstyledMessage`, in the vocabulary the run
   * stored, and always carried in the log so a support report keeps the cause.
   * Null on a styled run.
   *
   * It is never shown. For a response that came back unusable it is a developer
   * string (a parse error, a schema issue list, the token-limit warning); for a
   * request that never came back it is the recorded failure category, a closed
   * vocabulary the run builds from the HTTP status with the transcript stripped
   * out. `unstyledMessage` is the localized sentence for either, and
   * `postProcessErrorReason` is what turns the category into one.
   */
  unstyledReason: string | null;
  transcription: Transcription;
};

/**
 * The copy for a response that came back but could not be styled. The reason
 * the post-processing step recorded for that answer is a developer string (a
 * parse error, a schema issue list, the token-limit warning), so it is logged
 * and never shown. Only the outcome is localized, and a cut-off reply reads
 * differently from an unreadable one because running out of output budget and
 * receiving a broken payload are different problems for the user to retry.
 */
const unstyledResponseMessage = (reason: string): string => {
  if (!reason) {
    // Nothing was recorded, so there is no outcome to describe. The error
    // surface falls back to its own generic retranscription copy.
    return "";
  }
  const intl = getIntl();
  if (reason === POST_PROCESS_TRUNCATED_WARNING) {
    return intl.formatMessage({
      defaultMessage:
        "The styling reply was cut off at the model's output limit, so the partial reply was discarded and the previous text was kept.",
    });
  }
  return intl.formatMessage({
    defaultMessage:
      "The styling reply could not be read, so it was discarded and the previous text was kept.",
  });
};

/**
 * The surface copy and the log detail for a run that produced no styling. A
 * request that never came back reports its recorded failure category, which is
 * a closed vocabulary the row already stores: the user reads the localized
 * descriptor for it, and the category itself stays in the log. A response that
 * came back unusable has no category, so the cause comes from the warnings the
 * post-processing step already recorded on the run: it appends the reason it
 * dropped that answer last, after any dispatch or glossary warning, so the
 * final entry is the cause. That reason stays in the log; the user gets the
 * localized outcome sentence for it.
 */
const describeUnstyledRun = (
  metadata: PostProcessMetadata,
  postProcessWarnings: string[],
): { message: string; reason: string } => {
  if (orFalse(metadata.postProcessEditFailed)) {
    return {
      message: getIntl().formatMessage({
        defaultMessage:
          "The requested styling edits failed, so the complete raw transcript was kept in History.",
      }),
      reason: postProcessWarnings.at(-1) ?? "post-process-edit-failure",
    };
  }
  if (orFalse(metadata.postProcessFailed)) {
    const reason = metadata.postProcessError ?? "";
    return {
      // The category is internal vocabulary ("Rate limit exceeded (429)"), and
      // `showErrorSnackbar` renders its argument verbatim, so it is resolved to
      // its localized descriptor rather than printed. An unrecognized category
      // still resolves, to the generic provider error.
      message: reason
        ? getIntl().formatMessage(postProcessErrorReason(reason))
        : "",
      reason,
    };
  }
  const reason = postProcessWarnings.at(-1) ?? "";
  return { message: unstyledResponseMessage(reason), reason };
};

/**
 * Whether this run left the row without usable styling.
 *
 * `postProcessFallback` covers two different runs and cannot be read on its own.
 * A response that came back unusable sets it, and the text stored is raw ASR, so
 * the row must keep the text it already holds. A request that failed but whose
 * deterministic local style succeeded sets it too, and that text really is
 * styled, so treating it as unstyled would throw away the only polish the run
 * produced. A recorded failure category is what separates them: only the second
 * path records one, because only it had a request that never came back. The
 * same split is what the dictation strategy uses, where a degraded run is still
 * delivered and pasted.
 */
const isUnstyledPostProcess = (metadata: PostProcessMetadata): boolean =>
  orFalse(metadata.postProcessFailed) ||
  orFalse(metadata.postProcessEditFailed) ||
  (orFalse(metadata.postProcessFallback) && !metadata.postProcessError);

const updateStoredTranscription = async (
  transcription: Transcription,
  processed: ProcessedAudio,
): Promise<RetranscribeUpdate> => {
  const { transcribeResult, sanitizedTranscript, postProcessResult } =
    processed;
  const warnings = [
    ...transcribeResult.warnings,
    ...postProcessResult.warnings,
  ];
  const metadata = {
    ...transcribeResult.metadata,
    ...postProcessResult.metadata,
  };
  const finalTranscript = postProcessResult.transcript;
  if (!finalTranscript) throw new Error("Retranscription produced no text.");
  const unstyled = isUnstyledPostProcess(postProcessResult.metadata);
  const unstyledRun = unstyled
    ? describeUnstyledRun(
        postProcessResult.metadata,
        postProcessResult.warnings,
      )
    : null;

  const payload: Transcription = {
    ...transcription,
    transcript: unstyled
      ? // Nothing styled came back, so the text this row already holds stays
        // the best answer. Falling back to the new raw ASR covers a row that
        // was never styled in the first place.
        transcription.transcript || finalTranscript
      : finalTranscript,
    sanitizedTranscript,
    modelSize: metadata.modelSize ?? null,
    inferenceDevice: metadata.inferenceDevice ?? null,
    // The raw ASR from this run is the only record of what was actually said,
    // so it is stored even when the styled transcript is left untouched.
    rawTranscript: transcribeResult.rawTranscript || finalTranscript,
    transcriptionPrompt: metadata.transcriptionPrompt ?? null,
    postProcessPrompt: metadata.postProcessPrompt ?? null,
    transcriptionApiKeyId: metadata.transcriptionApiKeyId ?? null,
    postProcessApiKeyId: metadata.postProcessApiKeyId ?? null,
    transcriptionMode: metadata.transcriptionMode ?? null,
    postProcessMode: metadata.postProcessMode ?? null,
    postProcessDevice: metadata.postProcessDevice ?? null,
    postProcessModel: metadata.postProcessModel ?? null,
    // Match create-path sentinels: null = not attempted, true = failed,
    // false = succeeded. An unusable answer keeps the row's previous text and
    // carries its semantic edit-failure chain forward; a successful run clears
    // that chain so a later user-started chain can receive one recovery pass.
    postProcessProvider: metadata.postProcessProvider ?? null,
    postProcessFailed: unstyled
      ? (metadata.postProcessFailed ?? transcription.postProcessFailed ?? null)
      : (metadata.postProcessFailed ?? null),
    postProcessEditFailed: unstyled
      ? (metadata.postProcessEditFailed ??
        transcription.postProcessEditFailed ??
        null)
      : null,
    postProcessEditFailureCount: unstyled
      ? (metadata.postProcessEditFailureCount ??
        transcription.postProcessEditFailureCount ??
        null)
      : null,
    postProcessEditAutoRetryUsed: unstyled
      ? (metadata.postProcessEditAutoRetryUsed ??
        transcription.postProcessEditAutoRetryUsed ??
        null)
      : null,
    postProcessFallback: metadata.postProcessFallback ?? null,
    postProcessError: metadata.postProcessError ?? null,
    warnings: warnings.length > 0 ? warnings : null,
    // Durations must be re-read from the fresh run; spreading the old record
    // otherwise leaves stale timings in history after a retranscription.
    transcriptionDurationMs: metadata.transcriptionDurationMs ?? null,
    postprocessDurationMs: metadata.postprocessDurationMs ?? null,
  };
  // During an ephemeral session the update stays memory-only: build the fresh
  // payload for the caller but never write it through to the repository.
  const stored = isPersistenceAllowed()
    ? await getTranscriptionRepo().updateTranscription(payload)
    : payload;
  return {
    styled: !unstyled,
    unstyledMessage: unstyledRun?.message ?? null,
    unstyledReason: unstyledRun?.reason ?? null,
    transcription: stored,
  };
};

type RetranscribeTranscriptionParams = {
  transcriptionId: string;
  toneId?: string | null;
  languageCode?: string | null;
};

const RETRANSCRIBE_LOADING_SNACKBAR_MS = 2 * 60 * 1000;
const automaticRetranscriptionIds = new Set<string>();

/**
 * Whether this row is the one the automatic pass is owed to: a persisted
 * semantic edit failure past the failure threshold, with the audio still on
 * disk, that has not already been claimed by a pass in this process or in a
 * previous one.
 */
const canScheduleAutomaticRetry = (
  transcription: Transcription,
  failureCount: number,
): boolean =>
  isPersistenceAllowed() &&
  Boolean(transcription.audio?.filePath) &&
  transcription.postProcessEditFailed === true &&
  shouldAutomaticallyRetranscribePostProcessEditFailure(failureCount) &&
  transcription.postProcessEditAutoRetryUsed !== true &&
  !automaticRetranscriptionIds.has(transcription.id);

/**
 * Mark a durable row before waiting, then run the one automatic recovery pass
 * against that same row. The persisted marker makes the one-pass rule survive
 * a restart and prevents a later manual failure chain from scheduling another
 * automatic run for the same History item.
 */
export const scheduleAutomaticPostProcessEditRetry = async ({
  transcription,
  toneId,
  languageCode,
}: {
  transcription: Transcription;
  toneId?: string | null;
  languageCode?: string | null;
}): Promise<void> => {
  const failureCount = transcription.postProcessEditFailureCount;
  if (
    failureCount === null ||
    failureCount === undefined ||
    !canScheduleAutomaticRetry(transcription, failureCount)
  ) {
    return;
  }

  automaticRetranscriptionIds.add(transcription.id);
  try {
    // Claim from the row the app is holding, and check it before the write.
    // The caller can hand over a row that a user edit or a manual
    // retranscription has already replaced, and writing that stale row back
    // would undo the newer run. A missing row falls back to the caller's copy,
    // which is what the live and imported paths always supply.
    const current =
      getRec(getAppState().transcriptionById, transcription.id) ??
      transcription;
    if (
      current.postProcessEditFailed !== true ||
      current.postProcessEditFailureCount !== failureCount
    ) {
      automaticRetranscriptionIds.delete(transcription.id);
      return;
    }
    const marked = await getTranscriptionRepo().updateTranscription({
      ...current,
      postProcessEditAutoRetryUsed: true,
    });
    produceAppState((draft) => {
      draft.transcriptionById[transcription.id] = marked;
    });

    const delayMs = getPostProcessEditRetranscribeDelayMs(failureCount);
    getLogger().info(
      `Scheduling audio retranscription after repeated post-processing edit failures in ${delayMs}ms`,
    );

    void delayed(delayMs)
      .then(async () => {
        automaticRetranscriptionIds.delete(transcription.id);
        const latest = getRec(
          getAppState().transcriptionById,
          transcription.id,
        );
        if (
          latest?.postProcessEditFailed !== true ||
          latest.postProcessEditFailureCount !== failureCount ||
          latest.postProcessEditAutoRetryUsed !== true
        ) {
          return;
        }
        await retranscribeTranscription({
          transcriptionId: transcription.id,
          toneId,
          languageCode,
        });
      })
      .catch((error: unknown) => {
        automaticRetranscriptionIds.delete(transcription.id);
        getLogger().warning(
          `Automatic audio retranscription was skipped: ${error}`,
        );
      });
  } catch (error) {
    automaticRetranscriptionIds.delete(transcription.id);
    getLogger().warning(
      `Could not persist automatic audio retranscription marker: ${error}`,
    );
  }
};

const retranscribeGenerationById = new Map<string, number>();

const nextRetranscribeGeneration = (transcriptionId: string): number => {
  const next = (retranscribeGenerationById.get(transcriptionId) ?? 0) + 1;
  retranscribeGenerationById.set(transcriptionId, next);
  return next;
};

const isCurrentRetranscribeGeneration = (
  transcriptionId: string,
  generation: number,
): boolean => retranscribeGenerationById.get(transcriptionId) === generation;

const releaseRetranscribeGeneration = (
  transcriptionId: string,
  generation: number,
): void => {
  if (retranscribeGenerationById.get(transcriptionId) === generation) {
    retranscribeGenerationById.delete(transcriptionId);
  }
};

let ownsRetranscribeNativeToast = false;
/**
 * Bumped whenever a new batch of retranscribe loading feedback starts. A
 * completion toast whose generation is stale must not replace the newer
 * batch's loading toast.
 */
let retranscribeFeedbackGeneration = 0;

const retranscribeFeedbackCopy = () => {
  const intl = getIntl();
  return {
    loading: intl.formatMessage({
      defaultMessage: "Retranscribing audio clip",
    }),
    complete: intl.formatMessage({
      defaultMessage: "Retranscription complete",
    }),
    failed: intl.formatMessage({
      defaultMessage: "Unable to retranscribe audio snippet.",
    }),
  };
};

const showRetranscribeLoadingFeedback = () => {
  const { loading } = retranscribeFeedbackCopy();
  showSnackbar(loading, { duration: RETRANSCRIBE_LOADING_SNACKBAR_MS });
  ownsRetranscribeNativeToast = true;
  retranscribeFeedbackGeneration += 1;
  runToast(showPersistentToast(loading, RETRANSCRIBE_LOADING_SNACKBAR_MS));
};

const showRetranscribeSuccessFeedback = () => {
  const { complete } = retranscribeFeedbackCopy();
  showSnackbar(complete, { mode: "success" });
  // The completion toast carries its own short duration, so the long-lived
  // loading toast is no longer ours once it is replaced.
  ownsRetranscribeNativeToast = false;
  // The dismiss is a round trip, so a new batch can start loading feedback
  // before it resolves. Only show this completion toast while it is still the
  // newest feedback, or it would replace the newer run's loading toast.
  const generation = retranscribeFeedbackGeneration;
  const showComplete = () => {
    if (generation !== retranscribeFeedbackGeneration) {
      return undefined;
    }
    return showCompletionToast(complete);
  };
  // Show the completion toast even when the dismiss round trip fails, so a
  // transient IPC error cannot leave the user without the finished state.
  // Both handlers go on one `then` so the chain stays a single tick long.
  runToast(dismissToast().then(showComplete, showComplete));
};

const dismissRetranscribeLoadingFeedback = () => {
  if (!ownsRetranscribeNativeToast) {
    return;
  }
  ownsRetranscribeNativeToast = false;
  runToast(dismissToast());
};

const syncRetranscribeFeedback = (event: "success" | "error" | "abandoned") => {
  const inFlight = getAppState().transcriptions.retranscribingIds.length;
  if (inFlight > 0) {
    return;
  }
  if (event === "success") {
    showRetranscribeSuccessFeedback();
    return;
  }
  dismissRetranscribeLoadingFeedback();
};

const performRetranscribe = async ({
  transcriptionId,
  toneId,
  languageCode,
}: RetranscribeTranscriptionParams): Promise<RetranscribeUpdate> => {
  const transcription = getRec(
    getAppState().transcriptionById,
    transcriptionId,
  );
  if (!transcription) throw new Error("Transcription not found.");

  const audioData =
    await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
  const processed = await processAudio({
    samples: audioData.samples,
    sampleRate: audioData.sampleRate,
    toneId,
    languageCode,
    postProcessEditFailureCount:
      transcription.postProcessEditFailureCount ?? null,
  });
  const updated = await updateStoredTranscription(transcription, processed);

  produceAppState((draft) => {
    draft.transcriptionById[transcriptionId] = updated.transcription;
  });
  return updated;
};

/**
 * A newer run for this row replaced us. The newer run owns the row state, so
 * touching it here would clear its in-flight marker. Only release the shared
 * loading toast, and only once nothing is left running.
 */
const abandonRetranscribeRun = (): void => {
  syncRetranscribeFeedback("abandoned");
};

/**
 * Every route that ends a run without styling the row goes through here, so
 * the row is freed, the error is shown, the loading toast is cleared, and the
 * generation is released in one place. Releasing the generation matters as much
 * as the rest: it is what lets a later run for this row start, so a path that
 * reports an error without calling this would leave the row stuck in flight.
 * Callers must first confirm they still own the current generation.
 *
 * `message` is the localized sentence the user reads. `reason` carries the
 * recorded developer detail for a run that produced no styling, so the log
 * keeps the cause that the localized copy deliberately omits.
 */
const failRetranscribeRun = ({
  transcriptionId,
  generation,
  message,
  reason,
  error,
}: {
  transcriptionId: string;
  generation: number;
  message: string;
  reason?: string;
  error?: unknown;
}): void => {
  produceAppState((draft) => {
    finishRetranscribe(draft.transcriptions, transcriptionId, false);
  });
  console.error("Failed to retranscribe audio", error ?? reason ?? message);
  const { failed } = retranscribeFeedbackCopy();
  showErrorSnackbar(message || failed);
  syncRetranscribeFeedback("error");
  releaseRetranscribeGeneration(transcriptionId, generation);
};

export async function retranscribeTranscription(
  params: RetranscribeTranscriptionParams,
): Promise<void> {
  const { transcriptionId, toneId, languageCode } = params;
  if (
    isRetranscribingId(getAppState().transcriptions, transcriptionId) ||
    automaticRetranscriptionIds.has(transcriptionId)
  ) {
    return;
  }

  const generation = nextRetranscribeGeneration(transcriptionId);
  const wasAnyInFlight =
    getAppState().transcriptions.retranscribingIds.length > 0;
  produceAppState((draft) => {
    beginRetranscribe(draft.transcriptions, transcriptionId);
  });
  if (!wasAnyInFlight) {
    showRetranscribeLoadingFeedback();
  }

  try {
    const update = await performRetranscribe(params);
    if (!isCurrentRetranscribeGeneration(transcriptionId, generation)) {
      abandonRetranscribeRun();
      return;
    }
    if (!update.styled) {
      // The row now holds its previous text plus this run's raw ASR, which is
      // a usable outcome for the user but not the styling they asked for, so it
      // must not be reported as a finished retranscription.
      failRetranscribeRun({
        transcriptionId,
        generation,
        message: update.unstyledMessage ?? "",
        reason: update.unstyledReason ?? undefined,
      });
      void scheduleAutomaticPostProcessEditRetry({
        transcription: update.transcription,
        toneId,
        languageCode,
      });
      return;
    }
    produceAppState((draft) => {
      finishRetranscribe(draft.transcriptions, transcriptionId, true);
    });
    syncRetranscribeFeedback("success");
    globalThis.setTimeout(() => {
      if (!isCurrentRetranscribeGeneration(transcriptionId, generation)) {
        return;
      }
      produceAppState((draft) => {
        clearRetranscribeSuccess(draft.transcriptions, transcriptionId);
      });
      releaseRetranscribeGeneration(transcriptionId, generation);
    }, RETRANSCRIPTION_SUCCESS_VISIBLE_MS);
  } catch (error) {
    if (!isCurrentRetranscribeGeneration(transcriptionId, generation)) {
      abandonRetranscribeRun();
      return;
    }
    failRetranscribeRun({
      transcriptionId,
      generation,
      message: error instanceof Error ? error.message : "",
      error,
    });
  }
}

/**
 * Deliver the automatic recovery a previous process claimed and never ran.
 *
 * The claim is written before the back-off wait, so quitting, crashing, or
 * losing power during that wait leaves a row marked as claimed with no pass
 * running behind it. The failure count is what tells the two states apart: the
 * claim is written at the count that triggered it, and a pass that did run
 * stores a higher count when it fails again. So a marker still sitting at the
 * trigger count means the pass never reported back, and it is started here.
 *
 * Rows resume through the same retranscription path, which updates the existing
 * History row rather than writing a second one.
 */
const isResumableAutomaticRetry = (transcription: Transcription): boolean =>
  transcription.postProcessEditFailed === true &&
  transcription.postProcessEditAutoRetryUsed === true &&
  transcription.postProcessEditFailureCount ===
    POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER + 1 &&
  // A row already carrying a post-processing failure had its recovery attempt
  // delivered and recorded, so it must not be delivered again.
  transcription.postProcessFailed !== true &&
  Boolean(transcription.audio?.filePath);

/**
 * Deliver one claimed pass and make sure the attempt is recorded either way.
 *
 * A pass that reaches post-processing writes the row itself, and what lands
 * there is what tells this function the claim is settled: a styled run clears
 * the chain, and a run that failed styling stores a higher count. A pass that
 * fails before post-processing, for instance when the audio or the transcription
 * step fails, leaves the row exactly as it was, so nothing would stop the next
 * launch from delivering the same claim again. That case is recorded here as a
 * post-processing failure, which keeps the delivery to one attempt per claim.
 */
const resumeAutomaticRetry = async (
  transcription: Transcription,
): Promise<void> => {
  await retranscribeTranscription({ transcriptionId: transcription.id });
  const latest = getRec(getAppState().transcriptionById, transcription.id);
  if (
    latest === undefined ||
    latest.postProcessEditFailureCount !==
      transcription.postProcessEditFailureCount ||
    latest.postProcessEditAutoRetryUsed !== true
  ) {
    return;
  }
  try {
    const attempted = await getTranscriptionRepo().updateTranscription({
      ...latest,
      postProcessFailed: true,
    });
    produceAppState((draft) => {
      draft.transcriptionById[transcription.id] = attempted;
    });
  } catch (error) {
    getLogger().warning(
      `Could not record the interrupted audio retranscription attempt: ${error}`,
    );
  }
};

export const resumeInterruptedPostProcessEditRetries = (
  transcriptions: Transcription[],
): void => {
  if (!isPersistenceAllowed()) {
    return;
  }
  for (const transcription of transcriptions) {
    if (isResumableAutomaticRetry(transcription)) {
      void resumeAutomaticRetry(transcription);
    }
  }
};

export type ImportAudioParams = {
  toneId?: string | null;
  languageCode?: string | null;
};

/**
 * Ask Rust to select/decode a file, then use the exact live dictation pipeline.
 * Returns false when the native picker is cancelled so the UI can retain its
 * pending Style/Language selections.
 */
export const importAudioFile = async ({
  toneId,
  languageCode,
}: ImportAudioParams): Promise<boolean> => {
  const audio = await getTranscriptionRepo().importAudioFile();
  if (!audio) return false;
  const processed = await processAudio({
    samples: audio.samples,
    sampleRate: audio.sampleRate,
    toneId,
    languageCode,
  });
  const { transcribeResult, sanitizedTranscript, postProcessResult } =
    processed;

  const output = await storeTranscription({
    audio: { samples: audio.samples, sampleRate: audio.sampleRate },
    rawTranscript: transcribeResult.rawTranscript ?? null,
    sanitizedTranscript,
    transcript: postProcessResult.transcript ?? null,
    transcriptionMetadata: transcribeResult.metadata,
    postProcessMetadata: postProcessResult.metadata,
    warnings: [...transcribeResult.warnings, ...postProcessResult.warnings],
  });

  if (output.transcription) {
    void scheduleAutomaticPostProcessEditRetry({
      transcription: output.transcription,
      toneId,
      languageCode,
    });
  }

  if (!output.transcription && !isPersistenceAllowed()) {
    const memoryRecord: Transcription = {
      id: createId(),
      createdAt: dayjs().toISOString(),
      createdByUserId: getMyEffectiveUserId(getAppState()),
      transcript: postProcessResult.transcript ?? "",
      isDeleted: false,
      rawTranscript: transcribeResult.rawTranscript ?? null,
      sanitizedTranscript,
      modelSize: transcribeResult.metadata?.modelSize ?? null,
      inferenceDevice: transcribeResult.metadata?.inferenceDevice ?? null,
      transcriptionPrompt:
        transcribeResult.metadata?.transcriptionPrompt ?? null,
      postProcessPrompt: postProcessResult.metadata?.postProcessPrompt ?? null,
      transcriptionApiKeyId:
        transcribeResult.metadata?.transcriptionApiKeyId ?? null,
      postProcessApiKeyId:
        postProcessResult.metadata?.postProcessApiKeyId ?? null,
      transcriptionMode: transcribeResult.metadata?.transcriptionMode ?? null,
      postProcessMode: postProcessResult.metadata?.postProcessMode ?? null,
      postProcessDevice: postProcessResult.metadata?.postProcessDevice ?? null,
      postProcessModel: postProcessResult.metadata?.postProcessModel ?? null,
      postProcessProvider:
        postProcessResult.metadata?.postProcessProvider ?? null,
      postProcessFailed: postProcessResult.metadata?.postProcessFailed ?? null,
      postProcessEditFailed:
        postProcessResult.metadata?.postProcessEditFailed ?? null,
      postProcessEditFailureCount:
        postProcessResult.metadata?.postProcessEditFailureCount ?? null,
      postProcessEditAutoRetryUsed:
        postProcessResult.metadata?.postProcessEditAutoRetryUsed ?? null,
      postProcessFallback:
        postProcessResult.metadata?.postProcessFallback ?? null,
      postProcessError: postProcessResult.metadata?.postProcessError ?? null,
      warnings: [...transcribeResult.warnings, ...postProcessResult.warnings],
      audio: undefined,
      remoteStatus: null,
      remoteDeviceId: null,
      transcriptionDurationMs:
        transcribeResult.metadata?.transcriptionDurationMs ?? null,
      postprocessDurationMs:
        postProcessResult.metadata?.postprocessDurationMs ?? null,
    };
    produceAppState((draft) => {
      draft.transcriptionById[memoryRecord.id] = memoryRecord;
    });
  }
  return true;
};
