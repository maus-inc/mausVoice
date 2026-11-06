import { Transcription } from "@maus-inc/types";
import { delayed, getRec } from "@maus-inc/utilities";
import dayjs from "dayjs";
import { getIntl } from "../i18n/intl";
import { getTranscriptionRepo } from "../repos";
import {
  POST_PROCESS_EMPTY_REPLY_WARNING,
  POST_PROCESS_UNPARSEABLE_WARNING_PREFIX,
  POST_PROCESS_UNREADABLE_EDITS_WARNING,
} from "../utils/ai.utils";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";
import { createId } from "../utils/id.utils";
import { orFalse, orNull } from "../utils/nullable.utils";
import { registerTranscriptions } from "../utils/app.utils";
import {
  getTranscriptionDeletionRevision,
  isTranscriptionPendingDelete,
} from "../utils/pending-transcription-delete";
import { POST_PROCESS_TRUNCATED_WARNING } from "../utils/prompt.utils";
import {
  getFastStyleTruncationMessage,
  getPostProcessFeedback,
  getPostProcessFeedbackToastAction,
  type PostProcessFeedback,
} from "./post-process-feedback";
import {
  beginRetranscribe,
  clearRetranscribeSuccess,
  finishRetranscribe,
  isRetranscribingId,
  RETRANSCRIPTION_SUCCESS_VISIBLE_MS,
} from "../state/transcriptions.state";
import { getAppState, produceAppState } from "../store";
import {
  type LocalDataWriteLease,
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { sanitizeTranscriptText } from "../utils/sanitize-transcript.utils";
import {
  getPostProcessEditRetranscribeDelayMs,
  POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER,
  shouldAutomaticallyRetranscribePostProcessEditFailure,
} from "../utils/post-process-retry.utils";
import type { ReplacementRule } from "../utils/string.utils";
import type { ToastAction } from "../types/toast.types";
import {
  getMyDictationLanguage,
  getMyEffectiveUserId,
  getMyUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar, showSnackbar } from "./app.actions";
import {
  openPostProcessingSettings,
  openTranscriptionsHistory,
} from "./settings.actions";
import {
  dismissToast,
  getToastActionLabel,
  runToast,
  showCompletionToast,
  showPersistentToast,
} from "./toast.actions";
import {
  postProcessTranscript,
  storeTranscription,
  transcribeAudio,
  type PostProcessMetadata,
  type TranscriptionMetadata,
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

export type RetranscribeUpdate = {
  /** False when the run left the row without usable styling. */
  styled: boolean;
  /**
   * Why the row kept its previous text, phrased for the error surface. Null
   * on a styled run.
   */
  unstyledMessage: string | null;
  /** Recorded provider or parse detail, kept in logs and hidden from the user. */
  unstyledReason: string | null;
  /** Localized outcome and action for a run that left styling unavailable. */
  unstyledFeedback: PostProcessFeedback | null;
  /** Feedback for an unstyled audio tail when fast-style metadata reports one. */
  truncationMessage: string | null;
  transcription: Transcription;
};

export type RetranscribeRunResult = {
  /** False when another run or a pending automatic pass already owned the row. */
  started: boolean;
  /**
   * The outcome this run stored and still owned when it finished, or null
   * when nothing ran, the run was superseded, or it failed before storing
   * one, which are the states with nothing to recover from.
   */
  update: RetranscribeUpdate | null;
};

/**
 * Build localized feedback for a run that left the row without usable styling.
 * Provider details remain in the log; only the classified reason or outcome is
 * shown to the user.
 */
const getUnstyledRunReason = (
  metadata: PostProcessMetadata,
  postProcessWarnings: string[],
): string =>
  orFalse(metadata.postProcessFailed)
    ? (metadata.postProcessError ?? "")
    : (postProcessWarnings.at(-1) ?? "");

export const getUnusableResponseType = (
  reason: string,
): "truncated" | "unreadable" | undefined => {
  if (!reason) return undefined;
  return reason === POST_PROCESS_TRUNCATED_WARNING ? "truncated" : "unreadable";
};

/**
 * Rows can carry benign warnings next to an unusable-reply marker, so only the
 * marker strings themselves qualify for the explanatory feedback swap.
 */
export const isUnusableResponseWarning = (warning: string): boolean =>
  warning === POST_PROCESS_TRUNCATED_WARNING ||
  warning === POST_PROCESS_EMPTY_REPLY_WARNING ||
  warning === POST_PROCESS_UNREADABLE_EDITS_WARNING ||
  warning.startsWith(POST_PROCESS_UNPARSEABLE_WARNING_PREFIX);

const describeUnstyledRun = (
  metadata: PostProcessMetadata,
  postProcessWarnings: string[],
  hasPreviousTranscript: boolean,
  canRecoverFromHistory: boolean,
): {
  message: string;
  reason: string;
  feedback: PostProcessFeedback | null;
} => {
  // A rejected edit batch kept the complete raw transcript, so it gets the
  // dedicated edit-failure copy rather than the classified styling feedback.
  if (orFalse(metadata.postProcessEditFailed)) {
    return {
      message: getIntl().formatMessage({
        defaultMessage:
          "The requested styling edits failed, so the complete raw transcript was kept in History.",
      }),
      reason: postProcessWarnings.at(-1) ?? "post-process-edit-failure",
      feedback: null,
    };
  }
  const reason = getUnstyledRunReason(metadata, postProcessWarnings);
  const feedback = getPostProcessFeedback(metadata, "history-retranscription", {
    hasPreviousTranscript,
    unusableResponseType: getUnusableResponseType(reason),
    canRecoverFromHistory,
  });
  return { message: feedback?.message ?? "", reason, feedback };
};

const getFeedbackSnackbarAction = (
  feedback: Pick<PostProcessFeedback, "action">,
): { label: string; onClick: () => void } | undefined => {
  if (!feedback.action) return undefined;
  return {
    label: getToastActionLabel(
      getPostProcessFeedbackToastAction(feedback.action),
    ),
    onClick:
      feedback.action === "fix"
        ? openPostProcessingSettings
        : openTranscriptionsHistory,
  };
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

/** This run's value when it recorded one, otherwise the value the row holds. */
const carriedForward = <T>(
  next: T | null | undefined,
  previous: T | null | undefined,
): T | null => next ?? previous ?? null;

/**
 * The metadata-derived fields every retranscription copies onto the row, with
 * absent values normalized to the row's null sentinel. Durations are included
 * because they must be re-read from the fresh run; spreading the old record
 * otherwise leaves stale timings in history after a retranscription.
 */
type MetadataBackedTranscriptionFields = Pick<
  Transcription,
  | "modelSize"
  | "inferenceDevice"
  | "transcriptionPrompt"
  | "postProcessPrompt"
  | "transcriptionApiKeyId"
  | "postProcessApiKeyId"
  | "transcriptionMode"
  | "postProcessMode"
  | "postProcessDevice"
  | "postProcessModel"
  | "postProcessProvider"
  | "postProcessFallback"
  | "postProcessError"
  | "transcriptionDurationMs"
  | "postprocessDurationMs"
>;

const orNullMetadataFields = (
  metadata: TranscriptionMetadata,
): MetadataBackedTranscriptionFields => ({
  modelSize: orNull(metadata.modelSize),
  inferenceDevice: orNull(metadata.inferenceDevice),
  transcriptionPrompt: orNull(metadata.transcriptionPrompt),
  postProcessPrompt: orNull(metadata.postProcessPrompt),
  transcriptionApiKeyId: orNull(metadata.transcriptionApiKeyId),
  postProcessApiKeyId: orNull(metadata.postProcessApiKeyId),
  transcriptionMode: orNull(metadata.transcriptionMode),
  postProcessMode: orNull(metadata.postProcessMode),
  postProcessDevice: orNull(metadata.postProcessDevice),
  postProcessModel: orNull(metadata.postProcessModel),
  postProcessProvider: orNull(metadata.postProcessProvider),
  postProcessFallback: orNull(metadata.postProcessFallback),
  postProcessError: orNull(metadata.postProcessError),
  transcriptionDurationMs: orNull(metadata.transcriptionDurationMs),
  postprocessDurationMs: orNull(metadata.postprocessDurationMs),
});

/**
 * The four post-processing sentinels, under the rule the retranscribe path
 * keeps. They match the create-path sentinels: null = not attempted, true =
 * failed, false = succeeded. A styled run records its own outcome and clears
 * any previous edit-failure chain, so a later user-started chain can receive
 * one recovery pass. An unstyled run keeps the row's previous chain when this
 * run recorded nothing of its own, so an unusable answer cannot erase the
 * failure history the recovery decision reads.
 */
const postProcessOutcomeFields = (
  metadata: PostProcessMetadata,
  transcription: Transcription,
  unstyled: boolean,
): {
  postProcessFailed: boolean | null;
  postProcessEditFailed: boolean | null;
  postProcessEditFailureCount: number | null;
  postProcessEditAutoRetryUsed: boolean | null;
  postProcessEditRetryToneId: string | null;
  postProcessEditRetryLanguageCode: string | null;
  postProcessEditRetryClaimCount: number | null;
} =>
  unstyled
    ? {
        postProcessFailed: carriedForward(
          metadata.postProcessFailed,
          transcription.postProcessFailed,
        ),
        postProcessEditFailed: carriedForward(
          metadata.postProcessEditFailed,
          transcription.postProcessEditFailed,
        ),
        postProcessEditFailureCount: carriedForward(
          metadata.postProcessEditFailureCount,
          transcription.postProcessEditFailureCount,
        ),
        postProcessEditAutoRetryUsed: carriedForward(
          metadata.postProcessEditAutoRetryUsed,
          transcription.postProcessEditAutoRetryUsed,
        ),
        postProcessEditRetryToneId: orNull(
          transcription.postProcessEditRetryToneId,
        ),
        postProcessEditRetryLanguageCode: orNull(
          transcription.postProcessEditRetryLanguageCode,
        ),
        postProcessEditRetryClaimCount: orNull(
          transcription.postProcessEditRetryClaimCount,
        ),
      }
    : {
        postProcessFailed: orNull(metadata.postProcessFailed),
        postProcessEditFailed: null,
        postProcessEditFailureCount: null,
        postProcessEditAutoRetryUsed: null,
        postProcessEditRetryToneId: null,
        postProcessEditRetryLanguageCode: null,
        postProcessEditRetryClaimCount: null,
      };

/**
 * The text a retranscribed row should hold. Nothing styled came back, so the
 * text this row already holds stays the best answer; falling back to the new
 * raw ASR covers a row that was never styled in the first place.
 */
const resolveRetranscribedText = (
  transcription: Transcription,
  finalTranscript: string,
  unstyled: boolean,
): string =>
  // An unusable reply keeps meaningful existing text; a row whose previous
  // transcript is empty or whitespace-only has none, so it takes the new raw
  // ASR instead of preserving blanks.
  unstyled && transcription.transcript.trim().length > 0
    ? transcription.transcript
    : finalTranscript;

/** The message and reason pair an unstyled run reports, null on a styled one. */
const unstyledFeedback = (
  unstyledRun: { message: string; reason: string } | null,
): { unstyledMessage: string | null; unstyledReason: string | null } => ({
  unstyledMessage: unstyledRun?.message ?? null,
  unstyledReason: unstyledRun?.reason ?? null,
});

/**
 * During an ephemeral session the update stays memory-only: build the fresh
 * payload for the caller but never write it through to the repository.
 */
const persistTranscriptionUpdate = async (
  payload: Transcription,
  lease: LocalDataWriteLease,
): Promise<Transcription> =>
  isPersistenceAllowed()
    ? await getTranscriptionRepo().updateTranscription(payload, lease)
    : payload;

const updateStoredTranscription = async (
  transcription: Transcription,
  processed: ProcessedAudio,
  lease: LocalDataWriteLease,
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
  const hasPreviousTranscript = transcription.transcript.trim().length > 0;
  const canRecoverFromHistory = isPersistenceAllowed();
  const truncationMessage = getFastStyleTruncationMessage(
    postProcessResult.metadata.fastStyleTruncatedChars,
    { canRecoverFromHistory, context: "audio" },
  );
  const unstyled = isUnstyledPostProcess(postProcessResult.metadata);
  const unstyledRun = unstyled
    ? describeUnstyledRun(
        postProcessResult.metadata,
        postProcessResult.warnings,
        hasPreviousTranscript,
        canRecoverFromHistory,
      )
    : null;

  const payload: Transcription = {
    ...transcription,
    transcript: resolveRetranscribedText(
      transcription,
      finalTranscript,
      unstyled,
    ),
    sanitizedTranscript,
    ...orNullMetadataFields(metadata),
    ...postProcessOutcomeFields(metadata, transcription, unstyled),
    // The raw ASR from this run is the only record of what was actually said,
    // so it is stored even when the styled transcript is left untouched.
    rawTranscript: transcribeResult.rawTranscript || finalTranscript,
    warnings: warnings.length > 0 ? warnings : null,
  };
  const stored = await persistTranscriptionUpdate(payload, lease);
  return {
    styled: !unstyled,
    ...unstyledFeedback(unstyledRun),
    unstyledFeedback: unstyledRun?.feedback ?? null,
    truncationMessage,
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

type AutomaticRetryParams = {
  transcription: Transcription;
  toneId?: string | null;
  languageCode?: string | null;
};

/**
 * The restyle context a claim records for its recovery pass. An empty string
 * is the recorded "none": the failed run used no tone or no language override,
 * which is a value to restore, not a gap to fill from whatever the user has
 * selected by the time the pass runs. Null means no claim ever recorded one.
 */
type RecordedRetryContext = {
  toneId: string | null;
  languageCode: string | null;
};

const retryContextColumn = (value: string | null | undefined): string =>
  value ?? "";

/**
 * One restyle column read back as its claim recorded it. Undefined means no
 * claim ever wrote the column; null is the recorded "none" the empty string
 * stands for.
 */
const claimedRetryColumn = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value || null;
};

const recordedRetryContext = (
  transcription: Transcription,
): RecordedRetryContext | null => {
  const toneId = claimedRetryColumn(transcription.postProcessEditRetryToneId);
  const languageCode = claimedRetryColumn(
    transcription.postProcessEditRetryLanguageCode,
  );
  if (toneId === undefined || languageCode === undefined) {
    return null;
  }
  return { toneId, languageCode };
};

/**
 * A semantic edit failure this process has not already claimed for itself or
 * settled, so the row is still owed its one automatic recovery pass.
 */
const isClaimableEditFailure = (transcription: Transcription): boolean =>
  transcription.postProcessEditFailed === true &&
  transcription.postProcessEditAutoRetryUsed !== true;

const hasStoredAudio = (transcription: Transcription): boolean =>
  Boolean(transcription.audio?.filePath);

const canScheduleAutomaticRetry = (transcription: Transcription): boolean =>
  isClaimableEditFailure(transcription) &&
  hasStoredAudio(transcription) &&
  shouldAutomaticallyRetranscribePostProcessEditFailure(
    transcription.postProcessEditFailureCount,
  ) &&
  !automaticRetranscriptionIds.has(transcription.id);

/**
 * The failure count that makes this row eligible for its one automatic pass,
 * or null when it is not eligible. Persistence gates the claim because the
 * marker that enforces the one-pass rule is a durable column.
 */
const automaticRetryFailureCount = (
  transcription: Transcription,
): number | null => {
  if (!isPersistenceAllowed() || !canScheduleAutomaticRetry(transcription)) {
    return null;
  }
  return transcription.postProcessEditFailureCount ?? null;
};

/**
 * A row still standing at the failure count this claim was written for. The
 * live row can change under a claim, and only this exact state means the
 * failure that triggered it has not been superseded.
 */
const isClaimedFailureRow = (
  transcription: Transcription,
  failureCount: number,
): boolean =>
  transcription.postProcessEditFailed === true &&
  transcription.postProcessEditFailureCount === failureCount;

const retranscribeGenerationById = new Map<string, number>();

/**
 * Generations come from one global sequence rather than a per-row count: a
 * failed run releases its entry from the map, and a per-row count would then
 * hand the freed number to a later run, letting an older run's timer match
 * and clear it.
 */
let retranscribeGenerationSequence = 0;

const nextRetranscribeGeneration = (transcriptionId: string): number => {
  const next = ++retranscribeGenerationSequence;
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
type RetranscribeSuccessFeedback = Pick<
  PostProcessFeedback,
  "message" | "severity" | "action"
> & { duration?: number };
let pendingRetranscribeFeedback: RetranscribeSuccessFeedback | null = null;
let hasRetranscribeBatchError = false;

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
  pendingRetranscribeFeedback = null;
  hasRetranscribeBatchError = false;
  showSnackbar(loading, { duration: RETRANSCRIBE_LOADING_SNACKBAR_MS });
  ownsRetranscribeNativeToast = true;
  retranscribeFeedbackGeneration += 1;
  runToast(showPersistentToast(loading, RETRANSCRIBE_LOADING_SNACKBAR_MS));
};

const combineRetranscribeSuccessFeedback = (
  feedback: PostProcessFeedback | null,
  truncationMessage: string | null,
): RetranscribeSuccessFeedback | null => {
  const messages = [feedback?.message, truncationMessage].filter(
    (message): message is string => Boolean(message),
  );
  if (messages.length === 0) return null;

  return {
    message: messages.join(" "),
    severity: feedback?.severity ?? "info",
    action: feedback?.action,
    duration: truncationMessage ? 8_000 : undefined,
  };
};

/**
 * Rows that finished with the same outcome carry the same sentence, and one
 * row's message can sit inside another's: a truncation-only report is the tail
 * of a failure-plus-truncation report. Containment in either direction keeps
 * the fuller message instead of repeating the shorter one inside it.
 */
const mergeRetranscribeMessages = (
  existing: string,
  incoming: string,
): string => {
  if (existing.includes(incoming)) return existing;
  if (incoming.includes(existing)) return incoming;
  return [existing, incoming].join(" ");
};

/**
 * A batch shows one completion toast, but two rows finishing in the same
 * batch can each carry feedback. Merge them instead of letting the later row
 * overwrite the earlier one and drop its outcome from the toast.
 */
const mergeRetranscribeBatchFeedback = (
  existing: RetranscribeSuccessFeedback | null,
  incoming: RetranscribeSuccessFeedback,
): RetranscribeSuccessFeedback => {
  if (!existing) return incoming;
  return {
    message: mergeRetranscribeMessages(existing.message, incoming.message),
    severity: incoming.severity === "error" ? "error" : existing.severity,
    action: existing.action ?? incoming.action,
    duration: 8_000,
  };
};

const buildRetranscribeSnackbarOptions = (
  feedback: RetranscribeSuccessFeedback | null,
): {
  mode: "success" | RetranscribeSuccessFeedback["severity"];
  action?: { label: string; onClick: () => void };
} => {
  const action = feedback ? getFeedbackSnackbarAction(feedback) : undefined;
  return {
    mode: feedback ? feedback.severity : "success",
    ...(action ? { action } : {}),
  };
};

// The native completion toast carries the raw action token while the snackbar
// carries the mapped label and click handler; both come from the same outcome.
const getRetranscribeCompletionToastAction = (
  feedback: RetranscribeSuccessFeedback | null,
): ToastAction | undefined => {
  const action = feedback?.action;
  return action === "fix"
    ? getPostProcessFeedbackToastAction(action)
    : undefined;
};

const showRetranscribeSuccessFeedback = (
  feedback: RetranscribeSuccessFeedback | null = null,
) => {
  const { complete } = retranscribeFeedbackCopy();
  const message = feedback?.message ?? complete;
  showSnackbar(message, buildRetranscribeSnackbarOptions(feedback));
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
    const toastAction = getRetranscribeCompletionToastAction(feedback);
    if (toastAction) {
      return showCompletionToast(
        message,
        feedback?.duration ?? 4000,
        toastAction,
      );
    }
    return feedback?.duration
      ? showCompletionToast(message, feedback.duration)
      : showCompletionToast(message);
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
  if (hasRetranscribeBatchError) {
    hasRetranscribeBatchError = false;
    pendingRetranscribeFeedback = null;
    dismissRetranscribeLoadingFeedback();
    return;
  }
  if (
    event === "success" ||
    (event === "error" && pendingRetranscribeFeedback)
  ) {
    const feedback = pendingRetranscribeFeedback;
    pendingRetranscribeFeedback = null;
    showRetranscribeSuccessFeedback(feedback);
    return;
  }
  pendingRetranscribeFeedback = null;
  dismissRetranscribeLoadingFeedback();
};

const assertRetranscribeClearGeneration = (generation: number): void => {
  if (
    isLocalDataClearRequested() ||
    getLocalDataClearGeneration() !== generation
  ) {
    throw new Error("Local data was cleared during retranscription.");
  }
};

const performRetranscribe = async (
  { transcriptionId, toneId, languageCode }: RetranscribeTranscriptionParams,
  clearGeneration: number,
): Promise<RetranscribeUpdate> => {
  const transcription = getRec(
    getAppState().transcriptionById,
    transcriptionId,
  );
  if (!transcription) throw new Error("Transcription not found.");

  const audioData = await withLocalDataWrite((lease) => {
    assertRetranscribeClearGeneration(clearGeneration);
    return getTranscriptionRepo().loadTranscriptionAudio(
      transcriptionId,
      lease,
    );
  });
  assertRetranscribeClearGeneration(clearGeneration);

  // Provider and styling calls can take much longer than local DB work. Do not
  // keep a clear-drain lease while they run; the captured generation prevents
  // their late result from being persisted after a clear or retry.
  const processed = await processAudio({
    samples: audioData.samples,
    sampleRate: audioData.sampleRate,
    toneId,
    languageCode,
    postProcessEditFailureCount:
      transcription.postProcessEditFailureCount ?? null,
  });
  assertRetranscribeClearGeneration(clearGeneration);

  return withLocalDataWrite(async (lease) => {
    assertRetranscribeClearGeneration(clearGeneration);
    const updated = await updateStoredTranscription(
      transcription,
      processed,
      lease,
    );

    produceAppState((draft) => {
      draft.transcriptionById[transcriptionId] = updated.transcription;
    }, lease);
    return updated;
  });
};

/**
 * A newer run for this row replaced us. The newer run owns the row state, so
 * touching it here would clear its in-flight marker. Only release the shared
 * loading toast, and only once nothing is left running.
 */
const abandonRetranscribeRun = (): void => {
  syncRetranscribeFeedback("abandoned");
};

const cancelRetranscribeRunForClear = (
  transcriptionId: string,
  generation: number,
): void => {
  if (isCurrentRetranscribeGeneration(transcriptionId, generation)) {
    // This is transient in-memory feedback, not persisted local data. The
    // storage adapter rejects persistence while the clear gate is closed.
    produceAppState((draft) => {
      finishRetranscribe(draft.transcriptions, transcriptionId, false);
    });
    releaseRetranscribeGeneration(transcriptionId, generation);
  }
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
  feedback,
}: {
  transcriptionId: string;
  generation: number;
  message: string;
  reason?: string;
  error?: unknown;
  feedback?: PostProcessFeedback | null;
}): void => {
  produceAppState((draft) => {
    finishRetranscribe(draft.transcriptions, transcriptionId, false);
  });
  console.error("Failed to retranscribe audio", error ?? reason ?? message);
  const { failed } = retranscribeFeedbackCopy();
  if (feedback) {
    showSnackbar(message || feedback.message, {
      mode: feedback.severity,
      action: getFeedbackSnackbarAction(feedback),
    });
  } else {
    showErrorSnackbar(message || failed);
  }
  hasRetranscribeBatchError = true;
  pendingRetranscribeFeedback = null;
  syncRetranscribeFeedback("error");
  releaseRetranscribeGeneration(transcriptionId, generation);
};

/**
 * Start a run's in-flight bookkeeping: mark the row retranscribing and show
 * the loading feedback once, when this is the only run in flight.
 */
const beginRetranscribeRun = (transcriptionId: string): void => {
  const wasAnyInFlight =
    getAppState().transcriptions.retranscribingIds.length > 0;
  produceAppState((draft) => {
    beginRetranscribe(draft.transcriptions, transcriptionId);
  });
  if (!wasAnyInFlight) {
    showRetranscribeLoadingFeedback();
  }
};

/**
 * The success tail: fold the run's outcome into the batch feedback, mark the
 * row finished, show the completion feedback, and clear the success check once
 * it has been visible long enough. The timeout re-checks the generation so a
 * newer run's feedback is never cleared by an older run's timer.
 */
const finishRetranscribeSuccess = (
  transcriptionId: string,
  generation: number,
  update: RetranscribeUpdate,
): void => {
  const feedback = combineRetranscribeSuccessFeedback(
    getPostProcessFeedback(update.transcription, "history-retranscription"),
    update.truncationMessage,
  );
  if (feedback && !hasRetranscribeBatchError) {
    pendingRetranscribeFeedback = mergeRetranscribeBatchFeedback(
      pendingRetranscribeFeedback,
      feedback,
    );
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
};

/**
 * Local data was cleared or a newer clear started while a run was in flight,
 * so the run's result belongs to data the user asked to remove.
 */
const wasLocalDataCleared = (clearGeneration: number): boolean =>
  isLocalDataClearRequested() ||
  getLocalDataClearGeneration() !== clearGeneration;

/**
 * Apply a finished run's outcome to the row it owns. Returns the update the
 * run stored, or null when a newer run superseded it or local data was
 * cleared underneath it, which are the states a caller must not schedule a
 * recovery pass against.
 */
/**
 * Report a finished run whose styling could not be applied. The row holds its
 * previous text plus this run's raw ASR, which is a usable outcome for the
 * user but not the styling they asked for, so it must not be reported as a
 * finished retranscription.
 */
const failUnstyledRetranscribeRun = ({
  transcriptionId,
  generation,
  update,
}: {
  transcriptionId: string;
  generation: number;
  update: RetranscribeUpdate;
}): void => {
  failRetranscribeRun({
    transcriptionId,
    generation,
    // The row now holds its previous text plus this run's raw ASR, and a
    // fast-style tail can add its own sentence, so the report joins both.
    message: [update.unstyledMessage, update.truncationMessage]
      .filter((message): message is string => Boolean(message))
      .join(" "),
    reason: update.unstyledReason ?? undefined,
    feedback: update.unstyledFeedback,
  });
};

const completeRetranscribeRun = ({
  transcriptionId,
  generation,
  clearGeneration,
  update,
}: {
  transcriptionId: string;
  generation: number;
  clearGeneration: number;
  update: RetranscribeUpdate;
}): RetranscribeUpdate | null => {
  if (!isCurrentRetranscribeGeneration(transcriptionId, generation)) {
    abandonRetranscribeRun();
    return null;
  }
  if (wasLocalDataCleared(clearGeneration)) {
    cancelRetranscribeRunForClear(transcriptionId, generation);
    return null;
  }
  if (!update.styled) {
    failUnstyledRetranscribeRun({ transcriptionId, generation, update });
    return update;
  }
  finishRetranscribeSuccess(transcriptionId, generation, update);
  return update;
};

const handleRetranscribeError = ({
  transcriptionId,
  generation,
  clearGeneration,
  error,
}: {
  transcriptionId: string;
  generation: number;
  clearGeneration: number;
  error: unknown;
}): void => {
  if (!isCurrentRetranscribeGeneration(transcriptionId, generation)) {
    abandonRetranscribeRun();
    return;
  }
  if (wasLocalDataCleared(clearGeneration)) {
    cancelRetranscribeRunForClear(transcriptionId, generation);
    return;
  }
  failRetranscribeRun({
    transcriptionId,
    generation,
    message: error instanceof Error ? error.message : "",
    error,
  });
};

/**
 * Run one retranscription pass for a History row.
 *
 * Returns whether this call started a run, and the stored outcome when it
 * finished owning one. A false `started` means another run was already in
 * flight for the row, or a pending automatic pass already owned it, so
 * nothing ran and the caller must not read the row as settled by this call.
 * A null `update` means there is no owned outcome to act on: nothing ran,
 * the run was superseded, or it failed before it stored one. Callers that
 * want the one automatic recovery pass an unstyled outcome is owed use
 * retranscribeTranscriptionWithRecovery.
 */
export const retranscribeTranscription = async (
  params: RetranscribeTranscriptionParams,
): Promise<RetranscribeRunResult> => {
  const { transcriptionId } = params;
  if (
    isRetranscribingId(getAppState().transcriptions, transcriptionId) ||
    automaticRetranscriptionIds.has(transcriptionId) ||
    isLocalDataClearRequested()
  ) {
    return { started: false, update: null };
  }

  const clearGeneration = getLocalDataClearGeneration();
  const generation = nextRetranscribeGeneration(transcriptionId);
  beginRetranscribeRun(transcriptionId);

  try {
    const update = await performRetranscribe(params, clearGeneration);
    return {
      started: true,
      update: completeRetranscribeRun({
        transcriptionId,
        generation,
        clearGeneration,
        update,
      }),
    };
  } catch (error) {
    handleRetranscribeError({
      transcriptionId,
      generation,
      clearGeneration,
      error,
    });
    return { started: true, update: null };
  }
};

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
/**
 * The count a claim was written at is still the row's count. A claim can land
 * on a later failure in the chain, and matching the recorded value is what
 * tells a claim that never reported back from one whose pass ran and stored
 * a higher count. Rows claimed before the column existed recorded nothing,
 * and those claims were only ever written one failure past the threshold.
 */
const isClaimedFailureCountStillStanding = (
  transcription: Transcription,
): boolean =>
  transcription.postProcessEditFailureCount ===
  (transcription.postProcessEditRetryClaimCount ??
    POST_PROCESS_EDIT_FAILURE_RETRANSCRIBE_AFTER + 1);

const isResumableAutomaticRetry = (transcription: Transcription): boolean =>
  transcription.postProcessEditFailed === true &&
  transcription.postProcessEditAutoRetryUsed === true &&
  isClaimedFailureCountStillStanding(transcription) &&
  // A row already carrying a post-processing failure had its recovery attempt
  // delivered and recorded, so it must not be delivered again.
  transcription.postProcessFailed !== true &&
  Boolean(transcription.audio?.filePath);

/**
 * Record a delivered attempt that never reached post-processing, so a later
 * launch cannot deliver the same claim again. The row being unchanged from
 * the claim, with its count and marker still in place, is what tells a run
 * that failed before post-processing apart from one that settled the row.
 */
const recordUnsettledRetryAttempt = async (
  transcription: Transcription,
): Promise<void> => {
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

/**
 * Deliver one claimed pass and make sure the attempt is recorded either way.
 *
 * A pass that reaches post-processing writes the row itself, and what lands
 * there is what tells this function the claim is settled: a styled run clears
 * the chain, and a run that failed styling stores a higher count. A pass that
 * fails before post-processing, for instance when the audio or the
 * transcription step fails, leaves the row exactly as it was, so nothing
 * would stop the next launch from delivering the same claim again. That case
 * is recorded as a post-processing failure, which keeps the delivery to one
 * attempt per claim.
 *
 * A call that did not start a pass, because a manual run or the scheduler
 * already owned the row, records nothing: the owner settles the row, and a
 * quit before it does leaves the claim resumable rather than spent. Writing
 * the failure marker here anyway would let a duplicate caller spend the claim
 * while a pass is still in flight.
 *
 * A claim that cannot say which tone or language it was owed under, because it
 * predates the columns that record them, is settled without a pass: restyling
 * with whatever the user has selected by now would write a different style
 * over the raw transcript, and preserving that transcript is the whole point
 * of the recovery design.
 */
const resumeAutomaticRetry = async (
  transcription: Transcription,
): Promise<void> => {
  const context = recordedRetryContext(transcription);
  if (context === null) {
    await recordUnsettledRetryAttempt(transcription);
    return;
  }
  const { started } = await retranscribeTranscription({
    transcriptionId: transcription.id,
    toneId: context.toneId,
    languageCode: context.languageCode,
  });
  if (started) {
    await recordUnsettledRetryAttempt(transcription);
  }
};

/**
 * In-process ownership of a row's resumed pass. The History exit reset clears
 * the retranscribing markers from app state, but a fire-and-forget pass keeps
 * running behind it, so this module-level set — which no UI reset touches — is
 * what stops a remount from starting a second pass for the same row while the
 * first is still in flight.
 */
const resumingRetryIds = new Set<string>();

export const resumeInterruptedPostProcessEditRetries = (
  transcriptions: Transcription[],
): void => {
  if (!isPersistenceAllowed()) {
    return;
  }
  for (const transcription of transcriptions) {
    if (
      isResumableAutomaticRetry(transcription) &&
      !resumingRetryIds.has(transcription.id)
    ) {
      resumingRetryIds.add(transcription.id);
      // Fire-and-forget, with a backstop: the resume path records or
      // re-delivers on its own, and this catch only surfaces the unexpected.
      resumeAutomaticRetry(transcription)
        .catch((error: unknown) => {
          getLogger().warning(
            `Automatic audio retranscription resume failed: ${error}`,
          );
        })
        .finally(() => {
          // Released only once the attempt, including its
          // recordUnsettledRetryAttempt tail, has settled. The row an attempt
          // settled is no longer resumable, and one whose attempt failed
          // before settling stays claimable by a later pass, which is the
          // same rule a restart follows.
          resumingRetryIds.delete(transcription.id);
        });
    }
  }
};

/**
 * Walk every History page for interrupted claims. The paged list returns the
 * newest rows first, so a claim on an older row is never part of the page a
 * surface loads for its own list, and each page is registered before it is
 * delivered because the retranscription path reads the row from app state.
 */
export const resumeAllInterruptedPostProcessEditRetries = (): void => {
  const pageSize = 100;
  const generation = getLocalDataClearGeneration();
  const revision = getTranscriptionDeletionRevision();
  const scan = async (): Promise<void> => {
    for (let offset = 0; ; offset += pageSize) {
      if (isLocalDataClearRequested() || !isPersistenceAllowed()) return;
      const page = await getTranscriptionRepo().listTranscriptions({
        limit: pageSize,
        offset,
      });
      if (
        isLocalDataClearRequested() ||
        getLocalDataClearGeneration() !== generation ||
        getTranscriptionDeletionRevision() !== revision ||
        !isPersistenceAllowed()
      )
        return;
      const candidates = page.filter(
        (row) => !isTranscriptionPendingDelete(row.id),
      );
      produceAppState((draft) => {
        // A list response may predate an edit or another recovery scan.
        // Do not overwrite a live row with that older snapshot.
        registerTranscriptions(
          draft,
          candidates.filter((row) => !getRec(draft.transcriptionById, row.id)),
        );
      });
      resumeInterruptedPostProcessEditRetries(
        candidates
          .map((row) => getRec(getAppState().transcriptionById, row.id))
          .filter((row): row is Transcription => row !== undefined),
      );
      if (page.length < pageSize) {
        return;
      }
    }
  };
  // Fire-and-forget like the delivery it performs: startup must not wait on
  // scanning history that may turn out to be long.
  scan().catch((error: unknown) => {
    getLogger().warning(
      `Automatic audio retranscription history scan failed: ${error}`,
    );
  });
};

/**
 * Claim the live row before waiting. The claim is written from the row the app
 * is holding rather than the caller's copy, which a user edit or a manual
 * retranscription may already have replaced; a missing row falls back to the
 * caller's copy, which is what the live and imported paths always supply.
 * The failed run's tone and language are recorded with the marker, because the
 * process that resumes the claim after a restart has no other way to know
 * which style the pass is owed under. Returns the marked row, or null when the
 * live row no longer matches the failure that triggered the claim.
 */
const claimAutomaticRetryRow = async (
  params: AutomaticRetryParams,
  failureCount: number,
): Promise<Transcription | null> => {
  const { transcription, toneId, languageCode } = params;
  const current =
    getRec(getAppState().transcriptionById, transcription.id) ?? transcription;
  if (!isClaimedFailureRow(current, failureCount)) {
    return null;
  }
  const marked = await getTranscriptionRepo().updateTranscription({
    ...current,
    postProcessEditAutoRetryUsed: true,
    postProcessEditRetryToneId: retryContextColumn(toneId),
    postProcessEditRetryLanguageCode: retryContextColumn(languageCode),
    postProcessEditRetryClaimCount: failureCount,
  });
  produceAppState((draft) => {
    draft.transcriptionById[transcription.id] = marked;
  });
  return marked;
};

/**
 * Deliver the pass once the back-off expires: release the in-process claim,
 * re-check the live row, and hand it to the same resume path a restart uses,
 * which restyles under the context the claim recorded and records the attempt
 * when no pass can run. The count and the marker still sitting at their
 * claim-time values is what says no newer run superseded the claim while it
 * waited.
 */
const deliverAutomaticRetry = async (
  params: AutomaticRetryParams,
  failureCount: number,
): Promise<void> => {
  const { transcription } = params;
  automaticRetranscriptionIds.delete(transcription.id);
  const latest = getRec(getAppState().transcriptionById, transcription.id);
  if (
    latest === undefined ||
    !isClaimedFailureRow(latest, failureCount) ||
    latest.postProcessEditAutoRetryUsed !== true
  ) {
    return;
  }
  await resumeAutomaticRetry(latest);
};

const scheduleAutomaticRetryDelivery = (
  params: AutomaticRetryParams,
  failureCount: number,
  delayMs: number,
): void => {
  getLogger().info(
    `Scheduling audio retranscription after repeated post-processing edit failures in ${delayMs}ms`,
  );
  // Fire-and-forget: the delivery owns its failure reporting through the
  // catch below, so the caller never waits on the recovery pass.
  delayed(delayMs)
    .then(() => deliverAutomaticRetry(params, failureCount))
    .catch((error: unknown) => {
      automaticRetranscriptionIds.delete(params.transcription.id);
      getLogger().warning(
        `Automatic audio retranscription was skipped: ${error}`,
      );
    });
};

/**
 * Mark a durable row before waiting, then run the one automatic recovery pass
 * against that same row. The persisted marker makes the one-pass rule survive
 * a restart and prevents a later manual failure chain from scheduling another
 * automatic run for the same History item.
 */
export const scheduleAutomaticPostProcessEditRetry = async (
  params: AutomaticRetryParams,
): Promise<void> => {
  const { transcription } = params;
  const failureCount = automaticRetryFailureCount(transcription);
  if (failureCount === null) {
    return;
  }

  automaticRetranscriptionIds.add(transcription.id);
  try {
    const marked = await claimAutomaticRetryRow(params, failureCount);
    if (marked === null) {
      automaticRetranscriptionIds.delete(transcription.id);
      return;
    }
    scheduleAutomaticRetryDelivery(
      params,
      failureCount,
      getPostProcessEditRetranscribeDelayMs(failureCount),
    );
  } catch (error) {
    automaticRetranscriptionIds.delete(transcription.id);
    getLogger().warning(
      `Could not persist automatic audio retranscription marker: ${error}`,
    );
  }
};

/**
 * The manual retranscription entry: run the pass, then schedule the one
 * automatic recovery pass when the run could not apply its styling. The
 * automatic and resume paths call retranscribeTranscription directly, because
 * their claims are already written and one pass per claim is the rule.
 */
export const retranscribeTranscriptionWithRecovery = async (
  params: RetranscribeTranscriptionParams,
): Promise<RetranscribeRunResult> => {
  const result = await retranscribeTranscription(params);
  const { update } = result;
  if (update !== null && !update.styled) {
    // The scheduler returns once its claim is written and the delivery is
    // timed, so waiting here only covers the durable marker, never the pass.
    await scheduleAutomaticPostProcessEditRetry({
      transcription: update.transcription,
      toneId: params.toneId,
      languageCode: params.languageCode,
    });
  }
  return result;
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
    // The scheduler returns once its claim is written and the delivery is
    // timed, so waiting here only covers the durable marker, never the pass.
    await scheduleAutomaticPostProcessEditRetry({
      transcription: output.transcription,
      toneId,
      languageCode,
    });
  }

  const persistenceAllowed = isPersistenceAllowed();
  if (!output.transcription && !persistenceAllowed) {
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
      postProcessPrompt: postProcessResult.metadata.postProcessPrompt ?? null,
      transcriptionApiKeyId:
        transcribeResult.metadata?.transcriptionApiKeyId ?? null,
      postProcessApiKeyId:
        postProcessResult.metadata.postProcessApiKeyId ?? null,
      transcriptionMode: transcribeResult.metadata?.transcriptionMode ?? null,
      postProcessMode: postProcessResult.metadata.postProcessMode ?? null,
      postProcessDevice: postProcessResult.metadata.postProcessDevice ?? null,
      postProcessModel: postProcessResult.metadata.postProcessModel ?? null,
      postProcessProvider:
        postProcessResult.metadata.postProcessProvider ?? null,
      postProcessFailed: postProcessResult.metadata.postProcessFailed ?? null,
      postProcessEditFailed:
        postProcessResult.metadata.postProcessEditFailed ?? null,
      postProcessEditFailureCount:
        postProcessResult.metadata.postProcessEditFailureCount ?? null,
      postProcessEditAutoRetryUsed:
        postProcessResult.metadata.postProcessEditAutoRetryUsed ?? null,
      // Retry context is written only when a recovery pass claims the row.
      postProcessEditRetryToneId: null,
      postProcessEditRetryLanguageCode: null,
      postProcessFallback:
        postProcessResult.metadata.postProcessFallback ?? null,
      postProcessError: postProcessResult.metadata.postProcessError ?? null,
      warnings: [...transcribeResult.warnings, ...postProcessResult.warnings],
      audio: undefined,
      remoteStatus: null,
      remoteDeviceId: null,
      transcriptionDurationMs:
        transcribeResult.metadata?.transcriptionDurationMs ?? null,
      postprocessDurationMs:
        postProcessResult.metadata.postprocessDurationMs ?? null,
    };
    produceAppState((draft) => {
      draft.transcriptionById[memoryRecord.id] = memoryRecord;
    });
  }

  const canRecoverFromHistory = output.transcription !== null;
  // An incognito import keeps a memory row, so its transcript stays available
  // for this session. An import the store rejected while persistence was
  // allowed leaves no row anywhere, and the wording must not claim otherwise.
  const hasSessionRow = canRecoverFromHistory || !persistenceAllowed;
  const feedback = getPostProcessFeedback(
    postProcessResult.metadata,
    "audio-import",
    { canRecoverFromHistory, hasSessionRow },
  );
  const truncationMessage = getFastStyleTruncationMessage(
    postProcessResult.metadata.fastStyleTruncatedChars,
    { canRecoverFromHistory, context: "audio" },
  );
  const messages = [feedback?.message, truncationMessage].filter(
    (message): message is string => Boolean(message),
  );
  if (messages.length > 0) {
    showSnackbar(messages.join(" "), {
      mode: feedback?.severity ?? "info",
      action: feedback ? getFeedbackSnackbarAction(feedback) : undefined,
    });
  }
  return true;
};
