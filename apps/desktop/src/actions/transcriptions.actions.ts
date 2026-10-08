import { Transcription } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import dayjs from "dayjs";
import { getIntl } from "../i18n/intl";
import { getTranscriptionRepo } from "../repos";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { createId } from "../utils/id.utils";
import { orFalse } from "../utils/nullable.utils";
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
import { sanitizeTranscriptText } from "../utils/sanitize-transcript.utils";
import type { ReplacementRule } from "../utils/string.utils";
import {
  getMyDictationLanguage,
  getMyEffectiveUserId,
  getMyUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar, showSnackbar } from "./app.actions";
import { openPostProcessingSettings } from "./settings.actions";
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
  /** Recorded provider or parse detail, kept in logs and hidden from the user. */
  unstyledReason: string | null;
  /** Localized outcome and action for a run that left styling unavailable. */
  unstyledFeedback: PostProcessFeedback | null;
  /** Feedback for an unstyled audio tail when fast-style metadata reports one. */
  truncationMessage: string | null;
  transcription: Transcription;
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
  const reason = getUnstyledRunReason(metadata, postProcessWarnings);
  const feedback = getPostProcessFeedback(metadata, "history-retranscription", {
    hasPreviousTranscript,
    unusableResponseType: getUnusableResponseType(reason),
    canRecoverFromHistory,
  });
  return { message: feedback?.message ?? "", reason, feedback };
};

const openTranscriptionsHistory = (): void => {
  import("../router")
    .then(({ getBrowserRouter }) =>
      getBrowserRouter().navigate("/dashboard/transcriptions"),
    )
    .catch((error: unknown) => {
      console.error("Failed to open transcription history", error);
    });
};

const getFeedbackSnackbarAction = (
  feedback: PostProcessFeedback,
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
  const hasPreviousTranscript = transcription.transcript.trim().length > 0;
  const canRecoverFromHistory = isPersistenceAllowed();
  const truncationMessage = getFastStyleTruncationMessage(
    postProcessResult.metadata.fastStyleTruncatedChars,
    { canRecoverFromHistory, context: "audio" },
  );
  const unstyled = isUnstyledPostProcess(postProcessResult.metadata);
  // An unusable reply keeps meaningful existing text. Use new raw ASR only
  // when the row has none.
  const transcriptToPersist =
    unstyled && hasPreviousTranscript
      ? transcription.transcript
      : finalTranscript;
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
    transcript: transcriptToPersist,
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
    // false = succeeded (set explicitly on the success path). A failed request
    // and an unusable answer stay disjoint here: a degraded run leaves this
    // false because the request itself succeeded, and the reason it was
    // dropped rides on `warnings`, which the row does persist.
    postProcessProvider: metadata.postProcessProvider ?? null,
    postProcessFailed: metadata.postProcessFailed ?? null,
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
  const stored = canRecoverFromHistory
    ? await getTranscriptionRepo().updateTranscription(payload)
    : payload;
  return {
    styled: !unstyled,
    unstyledMessage: unstyledRun?.message ?? null,
    unstyledReason: unstyledRun?.reason ?? null,
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
    message: [existing.message, incoming.message].join(" "),
    severity: incoming.severity === "error" ? "error" : existing.severity,
    action: existing.action ?? incoming.action,
    duration: 8_000,
  };
};

const showRetranscribeSuccessFeedback = (
  feedback: RetranscribeSuccessFeedback | null = null,
) => {
  const { complete } = retranscribeFeedbackCopy();
  const message = feedback?.message ?? complete;
  const toastAction =
    feedback?.action === "fix"
      ? getPostProcessFeedbackToastAction(feedback.action)
      : undefined;
  showSnackbar(message, {
    mode: feedback ? feedback.severity : "success",
    ...(toastAction
      ? {
          action: {
            label: getToastActionLabel(toastAction),
            onClick: openPostProcessingSettings,
          },
        }
      : {}),
  });
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

export const retranscribeTranscription = async (
  params: RetranscribeTranscriptionParams,
): Promise<void> => {
  const { transcriptionId } = params;
  if (isRetranscribingId(getAppState().transcriptions, transcriptionId)) {
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
        message: [update.unstyledMessage, update.truncationMessage]
          .filter((message): message is string => Boolean(message))
          .join(" "),
        reason: update.unstyledReason ?? undefined,
        feedback: update.unstyledFeedback,
      });
      return;
    }
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
  const feedback = getPostProcessFeedback(
    postProcessResult.metadata,
    "audio-import",
    { canRecoverFromHistory },
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
