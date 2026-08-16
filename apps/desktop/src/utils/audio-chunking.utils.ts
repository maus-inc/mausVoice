export type AudioChunkPump = {
  pushSamples: (samples: Float32Array) => void;
  resetBuffers: () => void;
  flushPendingSamples: (force?: boolean) => void;
};

export type AudioChunkPumpCallbacks = {
  sampleRate: number;
  minChunkDurationMs: number;
  maxChunkDurationMs: number;
  canSend: () => boolean;
  /**
   * Called with each drained chunk ready for the wire. `isLastChunk` is true
   * when this is the final forced flush of a finalized session, which some
   * providers use to signal end-of-stream (e.g. ElevenLabs' commit flag).
   */
  sendChunk: (chunk: Float32Array, isLastChunk: boolean) => void;
  onError: (error: unknown) => void;
};

/**
 * Joins the committed transcript with the current partial segment, inserting
 * a single space between them. Shared by the streaming transcription sessions
 * so their transcript accumulation stays identical.
 */
export const combineStreamingTranscript = (
  finalTranscript: string,
  currentSegment: string,
): string =>
  finalTranscript +
  (currentSegment ? (finalTranscript ? " " : "") + currentSegment : "");

/**
 * Buffers incoming float32 audio chunks and drains them in frames sized to the
 * caller's chunk-duration window, delegating the actual wire format to
 * `sendChunk`. Shared by the streaming transcription sessions (AssemblyAI,
 * Deepgram, ElevenLabs) so their chunking/flushing behavior stays in one place.
 */
export const createAudioChunkPump = ({
  sampleRate,
  minChunkDurationMs,
  maxChunkDurationMs,
  canSend,
  sendChunk,
  onError,
}: AudioChunkPumpCallbacks): AudioChunkPump => {
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * minChunkDurationMs) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * maxChunkDurationMs) / 1000),
  );

  let pendingChunks: Float32Array[] = [];
  let pendingSampleCount = 0;

  const resetBuffers = () => {
    pendingChunks = [];
    pendingSampleCount = 0;
  };

  const drainSamples = (targetCount: number): Float32Array => {
    if (targetCount <= 0) {
      return new Float32Array(0);
    }
    const output = new Float32Array(targetCount);
    let filled = 0;

    while (filled < targetCount && pendingChunks.length > 0) {
      const current = pendingChunks[0];
      const remaining = targetCount - filled;
      if (current.length <= remaining) {
        output.set(current, filled);
        filled += current.length;
        pendingChunks.shift();
      } else {
        output.set(current.subarray(0, remaining), filled);
        pendingChunks[0] = current.subarray(remaining);
        filled += remaining;
      }
    }

    pendingSampleCount = Math.max(0, pendingSampleCount - filled);
    return filled === targetCount ? output : output.subarray(0, filled);
  };

  const shouldDrain = (force: boolean) =>
    pendingSampleCount >= minSamplesPerChunk ||
    (force && pendingSampleCount > 0);

  const computeChunkSize = (force: boolean): number | null => {
    const available = pendingSampleCount;
    if (available >= maxSamplesPerChunk) {
      return maxSamplesPerChunk;
    }
    if (available < minSamplesPerChunk && !force) {
      return null;
    }
    return available;
  };

  const padChunkIfNeeded = (
    chunk: Float32Array,
    force: boolean,
  ): Float32Array => {
    if (force && chunk.length > 0 && chunk.length < minSamplesPerChunk) {
      const padded = new Float32Array(minSamplesPerChunk);
      padded.set(chunk);
      return padded;
    }
    return chunk;
  };

  const flushPendingSamples = (force = false) => {
    if (!canSend()) {
      return;
    }

    while (shouldDrain(force)) {
      const chunkSize = computeChunkSize(force);
      if (chunkSize == null) {
        break;
      }

      const chunk = padChunkIfNeeded(drainSamples(chunkSize), force);
      if (chunk.length === 0) {
        break;
      }

      try {
        sendChunk(chunk, force && pendingSampleCount === 0);
      } catch (error) {
        onError(error);
        break;
      }
    }
  };

  const pushSamples = (samples: Float32Array) => {
    pendingChunks.push(samples);
    pendingSampleCount += samples.length;
  };

  return { pushSamples, resetBuffers, flushPendingSamples };
};
