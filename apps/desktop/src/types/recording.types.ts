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
