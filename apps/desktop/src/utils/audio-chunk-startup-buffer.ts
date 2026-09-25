export type StartupAudioChunk = number[] | Float32Array;

/** One buffered chunk plus its absolute sample index in the recording. */
type PendingAudioChunk = {
  samples: Float32Array;
  offset: number;
};

export type AudioChunkStartupBuffer = {
  push: (samples: StartupAudioChunk, offset: number) => void;
  setSink: (
    sink: ((chunk: Float32Array, offset: number) => void) | null,
  ) => void;
  setSampleRate: (sampleRate: number) => void;
  replay: () => void;
  reset: () => void;
  pendingSampleCount: () => number;
  overflowed: () => boolean;
};

const DEFAULT_MAX_STARTUP_SECONDS = 30;
const ASSUMED_STARTUP_SAMPLE_RATE = 48_000;

export const createAudioChunkStartupBuffer = (
  onOverflow?: (droppedSamples: number) => void,
  maxStartupSeconds = DEFAULT_MAX_STARTUP_SECONDS,
  initialSampleRate = ASSUMED_STARTUP_SAMPLE_RATE,
): AudioChunkStartupBuffer => {
  let maxSamples = Math.max(
    1,
    Math.ceil(maxStartupSeconds * Math.max(initialSampleRate, 1)),
  );
  let pendingChunks: PendingAudioChunk[] = [];
  let pendingSamples = 0;
  let droppedSamples = 0;
  let sink: ((chunk: Float32Array, offset: number) => void) | null = null;

  const reset = () => {
    pendingChunks = [];
    pendingSamples = 0;
    droppedSamples = 0;
    sink = null;
  };

  return {
    push: (samples, offset) => {
      if (samples.length === 0) return;
      const chunk: PendingAudioChunk = {
        samples: Float32Array.from(samples),
        offset,
      };
      const remaining = maxSamples - pendingSamples;
      if (remaining <= 0) {
        droppedSamples += chunk.samples.length;
        onOverflow?.(chunk.samples.length);
        return;
      }
      if (chunk.samples.length > remaining) {
        chunk.samples = chunk.samples.slice(0, remaining);
        droppedSamples += samples.length - remaining;
        onOverflow?.(samples.length - remaining);
      }
      pendingChunks.push(chunk);
      pendingSamples += chunk.samples.length;
    },
    setSink: (nextSink) => {
      sink = nextSink;
    },
    setSampleRate: (sampleRate) => {
      maxSamples = Math.max(
        1,
        Math.ceil(maxStartupSeconds * Math.max(sampleRate, 1)),
      );
      if (pendingSamples <= maxSamples) return;

      let remaining = maxSamples;
      let dropped = 0;
      const trimmed: PendingAudioChunk[] = [];
      for (const chunk of pendingChunks) {
        if (remaining === 0) {
          dropped += chunk.samples.length;
          continue;
        }
        if (chunk.samples.length <= remaining) {
          trimmed.push(chunk);
          remaining -= chunk.samples.length;
        } else {
          trimmed.push({
            ...chunk,
            samples: chunk.samples.slice(0, remaining),
          });
          dropped += chunk.samples.length - remaining;
          remaining = 0;
        }
      }
      pendingChunks = trimmed;
      pendingSamples = maxSamples - remaining;
      droppedSamples += dropped;
      onOverflow?.(dropped);
    },
    replay: () => {
      if (!sink) return;
      const chunks = pendingChunks;
      pendingChunks = [];
      pendingSamples = 0;
      for (const chunk of chunks) sink(chunk.samples, chunk.offset);
    },
    reset,
    pendingSampleCount: () => pendingSamples,
    overflowed: () => droppedSamples > 0,
  };
};
