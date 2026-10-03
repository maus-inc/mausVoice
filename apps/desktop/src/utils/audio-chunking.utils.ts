import { drainSamples as drainSamplesFromQueue } from "../sessions/audio-buffer.utils";

export type AudioChunkPump = {
  pushSamples: (samples: Float32Array) => void;
  resetBuffers: () => void;
  flushPendingSamples: (force?: boolean, final?: boolean) => void;
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
  /**
   * True once the session is finalizing. The final forced flush has no later
   * flush behind it, so audio it fails to send cannot be carried by a
   * subsequent one -- see the restore in `flushPendingSamples`.
   */
  isFinalizing?: () => boolean;
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
  isFinalizing,
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

  const flushPendingSamples = (force = false, final = false) => {
    if (!canSend()) {
      return;
    }

    let sentTerminal = false;
    while (shouldDrain(force)) {
      const chunkSize = computeChunkSize(force);
      if (chunkSize == null) {
        break;
      }

      const drained = drainSamples(chunkSize);
      const chunk = padChunkIfNeeded(drained, force);
      if (chunk.length === 0) {
        break;
      }

      try {
        const isLastChunk = force && pendingSampleCount === 0;
        sendChunk(chunk, isLastChunk);
        sentTerminal = isLastChunk;
      } catch (error) {
        // The samples left the queue before they went on the wire, so a failed
        // send is a silent drop: the socket can recover, and the audio in hand
        // is the only copy there is.
        //
        // Restoring them in front of the queue is what lets a later flush carry
        // that audio instead of silence. The exception is the finalizing
        // flush: there is no later one, because the buffer is reset once the
        // session is done. Samples parked there would never reach the provider
        // and would leave the tracked count claiming audio that is already
        // gone, so that loss is reported through onError instead.
        //
        // They go back unpadded either way: the padding is a send-time
        // artefact, and putting it back would inflate the buffered count a
        // little more on every retry.
        if (!(final || isFinalizing?.())) {
          pendingChunks.unshift(drained);
          pendingSampleCount += drained.length;
        }
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
