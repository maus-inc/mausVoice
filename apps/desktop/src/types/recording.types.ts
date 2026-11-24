export type StopRecordingResponse = {
  samples: number[] | Float32Array;
  sampleRate?: number;
  /**
   * The capture failed partway through, so `samples` is what was recorded
   * before it did. Native reports this in the top bit of the sample-rate
   * header, which `decodeStopRecordingPayload` reads and clears.
   */
  captureFailed?: boolean;
  /**
   * Set when the native capture reported that the stream was gone before the
   * recording was stopped, so `capturedMs` is what survived of `expectedMs`.
   */
  captureFault?: "fatal";
  /** Audio actually captured, in milliseconds. Only present with `captureFault`. */
  capturedMs?: number;
  /** How long the recorder believed it was recording. Only with `captureFault`. */
  expectedMs?: number;
};
