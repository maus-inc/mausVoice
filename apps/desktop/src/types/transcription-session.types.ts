import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "./transcription-metadata.types";

export type StopRecordingResponse = {
  samples: number[] | Float32Array;
  sampleRate?: number;
  /**
   * The capture failed partway through, so `samples` is what was recorded
   * before it did. Native reports this in the top bit of the sample-rate
   * header, which `decodeStopRecordingPayload` reads and clears.
   */
  captureFailed?: boolean;
};

export type TranscriptionSessionResult = {
  rawTranscript: string | null;
  processedTranscript?: string | null;
  metadata: TranscribeAudioMetadata;
  postProcessMetadata?: PostProcessMetadata;
  warnings: string[];
};

export type InterimResultCallback = (segment: string) => void;

export interface TranscriptionSession {
  /** Runs before the microphone opens, so audio from the first instant is observable. */
  onBeforeRecordingStart?(): Promise<void>;
  onRecordingStart(sampleRate: number, signal?: AbortSignal): Promise<void>;
  finalize(audio: StopRecordingResponse): Promise<TranscriptionSessionResult>;
  cleanup(): void;
  /** Whether the session exposes committed interim transcript segments to the UI. */
  supportsStreaming(): boolean;
  /**
   * Accepts one ordered live-audio chunk. `offset` is the chunk's absolute
   * sample index in the recording, so a session that aligns the live stream
   * against the final recording can reject a gap instead of guessing. Sessions
   * may retain the typed array, so callers must not mutate it after this call.
   * Calls after finalization or cleanup are no-ops.
   */
  writeAudioChunk?: (chunk: Float32Array, offset: number) => void;
  /** Provider-owned hard limit, measured as wall-clock time from recording start. */
  getMaximumRecordingDurationMs?(): number;
  setInterimResultCallback(callback: InterimResultCallback): void;
}
