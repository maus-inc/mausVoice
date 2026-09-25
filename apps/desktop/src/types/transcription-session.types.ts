import {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";

export type StopRecordingResponse = {
  samples: number[] | Float32Array;
  sampleRate?: number;
};

export type TranscriptionSessionResult = {
  rawTranscript: string | null;
  processedTranscript?: string | null;
  metadata: TranscribeAudioMetadata;
  postProcessMetadata?: PostProcessMetadata;
  warnings: string[];
};

export type TranscriptionSessionFinalizeOptions = {
  toneId?: string | null;
  a11yInfo?: unknown;
};

export type InterimResultCallback = (segment: string) => void;

export interface TranscriptionSession {
  onRecordingStart(sampleRate: number): Promise<void>;
  finalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult>;
  cleanup(): void;
  /** Whether the session exposes committed interim transcript segments to the UI. */
  supportsStreaming(): boolean;
  /**
   * Accepts one ordered live-audio chunk. Sessions may retain the typed array,
   * so callers must not mutate it after this call. Calls after finalization or
   * cleanup are no-ops.
   */
  writeAudioChunk?: (chunk: Float32Array) => void;
  /** Provider-owned hard limit, measured as wall-clock time from recording start. */
  getMaximumRecordingDurationMs?(): number;
  setInterimResultCallback(callback: InterimResultCallback): void;
}
