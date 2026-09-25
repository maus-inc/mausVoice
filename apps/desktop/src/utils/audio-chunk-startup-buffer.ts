export type StartupAudioChunk = number[] | Float32Array;

export type AudioChunkStartupBuffer = {
  push: (samples: StartupAudioChunk) => void;
  setSink: (sink: ((chunk: Float32Array) => void) | null) => void;
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
  const maxSamples = Math.max(
    1,
    Math.ceil(maxStartupSeconds * Math.max(initialSampleRate, 1)),
  );
  let pendingChunks: Float32Array[] = [];
  let pendingSamples = 0;
  let droppedSamples = 0;
  let sink: ((chunk: Float32Array) => void) | null = null;

  const reset = () => {
    pendingChunks = [];
    pendingSamples = 0;
    droppedSamples = 0;
    sink = null;
  };

  return {
    push: (samples) => {
      if (samples.length === 0) return;
      const chunk = Float32Array.from(samples);
      const remaining = maxSamples - pendingSamples;
      if (remaining <= 0) {
        droppedSamples += chunk.length;
        onOverflow?.(chunk.length);
        return;
      }
      if (chunk.length > remaining) {
        pendingChunks.push(chunk.slice(0, remaining));
        pendingSamples += remaining;
        droppedSamples += chunk.length - remaining;
        onOverflow?.(chunk.length - remaining);
        return;
      }
      pendingChunks.push(chunk);
      pendingSamples += chunk.length;
    },
    setSink: (nextSink) => {
      sink = nextSink;
    },
    replay: () => {
      if (!sink) return;
      const chunks = pendingChunks;
      pendingChunks = [];
      pendingSamples = 0;
      for (const chunk of chunks) sink(chunk);
    },
    reset,
    pendingSampleCount: () => pendingSamples,
    overflowed: () => droppedSamples > 0,
  };
};
