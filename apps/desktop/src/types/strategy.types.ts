import type { AppTarget, Nullable } from "@maus-inc/types";
import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";
import type { TextFieldInfo } from "./accessibility.types";
import type { ToastAction } from "./toast.types";
import type { StopRecordingResponse } from "./transcription-session.types";

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
  /** True when the review Open callback already persisted the History row. */
  historyPersisted?: boolean;
};
