import {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";
import type { RecordingAudioRelay } from "../sessions/recording-audio-relay";

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

export type InterimResultCallback = (segment: string) => void;

export interface TranscriptionSession {
  /**
   * True when the session reads the recorder's live `audio_chunk` stream
   * through a {@link RecordingAudioRelay} instead of subscribing itself. A
   * capture entry point opens a relay only for these sessions, and registers
   * it before `start_recording`, so a slow session start can never lose audio
   * the recorder had already produced.
   */
  readonly consumesAudioChunkRelay?: boolean;
  /**
   * Takes ownership of the relay, which the session releases in `cleanup()`.
   * The session binds its pretranscriber to the relay during
   * `onRecordingStart`, which can be minutes behind the relay.
   */
  attachAudioChunkRelay?(relay: RecordingAudioRelay): void;
  onRecordingStart(sampleRate: number): Promise<void>;
  finalize(audio: StopRecordingResponse): Promise<TranscriptionSessionResult>;
  cleanup(): void;
  supportsStreaming(): boolean;
  /** Provider-owned hard limit, measured as wall-clock time from recording start. */
  getMaximumRecordingDurationMs?(): number;
  setInterimResultCallback(callback: InterimResultCallback): void;
}
