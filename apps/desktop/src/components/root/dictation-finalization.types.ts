import type { AppTarget } from "@maus-inc/types";
import type { storeTranscription } from "../../actions/transcribe.actions";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TextFieldInfo } from "../../types/accessibility.types";
import type { ReviewedTranscriptPersistenceInput } from "../../types/strategy.types";
import type {
  StopRecordingResponse,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import type { PipelineTrace } from "../../utils/pipeline-trace";

export type RawStopResp = {
  shouldContinue: boolean;
  abortMessage?: string;
};

export type HandleEmptyResultInput = {
  audio: StopRecordingResponse;
  transcribeResult: TranscriptionSessionResult | undefined;
  strategy: Pick<BaseStrategy, "shouldStoreTranscript">;
  formatMessage: (descriptor: { defaultMessage: string }) => string;
  showToast: (options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
    isCurrent?: () => boolean;
    microphoneSafetyOwner?: string;
  }) => Promise<void> | void;
  storeTranscriptionFn: typeof storeTranscription;
  refreshMember: () => void;
  isCurrent?: () => boolean;
};

export type PostTranscriptInput = {
  audio: StopRecordingResponse;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  toneId: string | null;
  rawTranscript: string;
  transcribeResult: TranscriptionSessionResult;
  strategy: Pick<BaseStrategy, "handleTranscript" | "shouldStoreTranscript">;
  isAgentMode: boolean;
  handleTranscriptTimeoutMs: number;
  sendIdle: () => Promise<void>;
  storeTranscriptionFn: typeof storeTranscription;
  refreshMember: () => void;
  /** Informational surface for warnings the user has to know about mid-flow. */
  showToast: (options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
    isCurrent?: () => boolean;
  }) => Promise<void> | void;
  /** Review-before-insert persistence hook; forwarded to the strategy. */
  persistReviewedTranscript?: (
    input: ReviewedTranscriptPersistenceInput,
  ) => Promise<boolean>;
  /** Pipeline timing marks threaded through to History storage. */
  trace?: PipelineTrace | null;
  isCurrent?: () => boolean;
};

export type FinalizedRecording = {
  audio: StopRecordingResponse;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  toneId: string | null;
  rawTranscript: string;
  transcribeResult: TranscriptionSessionResult;
  isCurrent: () => boolean;
};
