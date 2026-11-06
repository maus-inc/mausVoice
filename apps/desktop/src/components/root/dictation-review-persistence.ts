import type { storeTranscription } from "../../actions/transcribe.actions";
import type { ReviewedTranscriptPersistenceInput } from "../../types/strategy.types";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import { getLogger } from "../../utils/log.utils";
import { startAsPromise } from "../../utils/promise.utils";
import { captureUserSession } from "../../utils/user-session.utils";
import type { PipelineTrace } from "../../utils/pipeline-trace";

/**
 * Run a notification and report its failure through `onFailure`. Both a
 * synchronous throw and a rejected promise reach the same place, because a
 * notification must never turn a handled save into a rejection.
 */
const notifySafely = (
  notify: () => Promise<unknown>,
  onFailure: () => void,
): void => {
  // A synchronous throw from notify() reaches the same handler as a rejection.
  void startAsPromise(notify).catch(onFailure);
};

/** Capture the recording's trace and metadata before the review may outlive it. */
export function createReviewedTranscriptPersistence({
  audio,
  rawTranscript,
  transcribeResult,
  trace,
  store,
  surface,
  showToast,
  formatFailure,
}: {
  audio: StopRecordingResponse;
  rawTranscript: string | null;
  transcribeResult: TranscriptionSessionResult;
  trace: PipelineTrace | null;
  store: typeof storeTranscription;
  surface: (isCurrent: () => boolean) => Promise<void>;
  showToast: (options: {
    message: string;
    toastType: "error";
    duration: number;
    isCurrent?: () => boolean;
  }) => Promise<unknown>;
  formatFailure: () => string;
}) {
  const isCurrentSession = captureUserSession();
  const report = (message: string) => {
    try {
      if (isCurrentSession()) getLogger().warning(message);
    } catch {
      // Logging must not turn a handled notification failure into a rejection.
    }
  };
  return async ({
    transcript,
    sanitizedTranscript,
    postProcessMetadata,
    postProcessWarnings,
  }: ReviewedTranscriptPersistenceInput): Promise<boolean> => {
    if (!isCurrentSession()) return false;
    try {
      const stored = await store({
        audio,
        rawTranscript,
        sanitizedTranscript,
        transcript,
        transcriptionMetadata: transcribeResult.metadata,
        postProcessMetadata,
        warnings: [...transcribeResult.warnings, ...postProcessWarnings],
        remoteStatus: null,
        remoteDeviceId: null,
        trace,
      });
      if (!isCurrentSession()) return false;
      if (stored.transcription) {
        notifySafely(
          () => surface(isCurrentSession),
          () => report("Could not open saved transcript history"),
        );
        return isCurrentSession();
      }
    } catch (error) {
      if (!isCurrentSession()) return false;
      getLogger().warning(
        `Could not store the reviewed transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const notifyFailure = () =>
      report("Could not display the review save failure");
    try {
      const message = formatFailure();
      if (isCurrentSession()) {
        notifySafely(
          () =>
            showToast({
              message,
              toastType: "error",
              duration: 8_000,
              isCurrent: isCurrentSession,
            }),
          notifyFailure,
        );
      }
    } catch {
      notifyFailure();
    }
    return false;
  };
}
