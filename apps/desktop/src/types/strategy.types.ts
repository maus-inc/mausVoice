import type { AppTarget, Nullable } from "@maus-inc/types";
import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";
import type { TextFieldInfo } from "./accessibility.types";
import type { ToastAction } from "./toast.types";
import type { StopRecordingResponse } from "./transcription-session.types";
import type { PipelineTrace } from "../utils/pipeline-trace";

export type StrategyValidationError = {
  title: string;
  body: string;
  action: Nullable<ToastAction>;
};

export type ReviewedTranscriptPersistenceInput = {
  transcript: string;
  sanitizedTranscript: string | null;
  postProcessMetadata: PostProcessMetadata;
  postProcessWarnings: string[];
};

export type HandleTranscriptParams = {
  rawTranscript: string;
  processedTranscript?: string | null;
  serverPostProcessMetadata?: PostProcessMetadata;
  toneId: string | null;
  a11yInfo: TextFieldInfo | null;
  currentApp: AppTarget | null;
  loadingToken: symbol | null;
  audio: StopRecordingResponse;
  transcriptionMetadata: TranscribeAudioMetadata;
  transcriptionWarnings: string[];
  trace?: PipelineTrace | null;
  /**
   * Persists a reviewed Open edit and navigates to History. It returns false
   * when persistence is unavailable so the pill keeps the review intact.
   */
  persistReviewedTranscript?: (
    input: ReviewedTranscriptPersistenceInput,
  ) => Promise<boolean>;
};

export type HandleTranscriptResult = {
  shouldContinue: boolean;
  transcript: string | null;
  sanitizedTranscript: string | null;
  postProcessMetadata: PostProcessMetadata;
  postProcessWarnings: string[];
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
  historyOwner?: HistoryOwner;
};

/**
 * Who owns the History row for an utterance once the strategy has handled it.
 *
 * A boolean cannot express this, because "nobody persisted it yet" and "the
 * review tried and failed" both read as false while needing opposite handling:
 * the first is the stop path's to write, the second belongs to the pill.
 */
export type HistoryOwner =
  /** Nobody has written the row, so the stop path must. The default. */
  | "stop-path"
  /** The review Open callback already wrote the row. */
  | "review"
  /**
   * The review Open callback tried and could not. The failure toast tells the
   * user the transcript is still on the pill to retry from, so the stop path
   * must not write it as well: that would contradict the promise and leave the
   * retry writing a duplicate row.
   */
  | "pill";
