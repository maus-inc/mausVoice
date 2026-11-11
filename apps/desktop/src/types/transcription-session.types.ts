import {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";

export type StopRecordingResponse = {
  samples: number[] | Float32Array;
  sampleRate?: number;
  /**
   * Set when the native capture reported that the stream was gone before the
   * recording was stopped — the device was unplugged, or the host invalidated
   * the stream.
   *
   * Absent on every ordinary recording, including the object-payload form a
   * browser or test double produces. Code that branches on this must treat
   * `undefined` as "nothing was reported", which is not the same as "the
   * capture was healthy": a stream that goes quiet without saying so is
   * invisible here and is only visible in the native log.
   */
  captureFault?: "fatal";
  /** Audio actually captured, in milliseconds. Only present with `captureFault`. */
  capturedMs?: number;
  /** How long the recorder believed it was recording. Only with `captureFault`. */
  expectedMs?: number;
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
