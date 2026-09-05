import { drainSamples as drainSamplesFromQueue } from "../sessions/audio-buffer.utils";

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
  maxBufferedSamples?: number;
};

/**
 * Joins the committed transcript with the current partial segment, inserting
 * a single space between them. Shared by the streaming transcription sessions
 * so their transcript accumulation stays identical.
 */
export const combineStreamingTranscript = (
  finalTranscript: string,
  currentSegment: string,
): string => {
  if (!currentSegment) {
    return finalTranscript;
  }
  const separator = finalTranscript ? " " : "";
  return finalTranscript + separator + currentSegment;
};

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
  maxBufferedSamples,
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
    const counter = { value: pendingSampleCount };
    const drained = drainSamplesFromQueue(pendingChunks, counter, targetCount);
    pendingSampleCount = counter.value;
    return drained;
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

    let sentTerminal = false;
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
        const isLastChunk = force && pendingSampleCount === 0;
        sendChunk(chunk, isLastChunk);
        sentTerminal = isLastChunk;
      } catch (error) {
        onError(error);
        break;
      }
    }

    // Providers such as ElevenLabs map isLastChunk to commit. A forced flush
    // with an empty buffer must still emit a terminal signal.
    if (force && !sentTerminal) {
      try {
        sendChunk(new Float32Array(0), true);
      } catch (error) {
        onError(error);
      }
    }
  };

  const pushSamples = (samples: Float32Array) => {
    if (
      maxBufferedSamples !== undefined &&
      pendingSampleCount + samples.length > maxBufferedSamples
    ) {
      throw new Error("Audio startup buffer limit exceeded.");
    }
    // Copy on push so the pending queue owns its buffers. drainSamples keeps
    // subarray views into these chunks; without the copy a caller that reuses
    // its source buffer could mutate audio we have not yet sent.
    pendingChunks.push(samples.slice());
    pendingSampleCount += samples.length;
  };

  return { pushSamples, resetBuffers, flushPendingSamples };
};
