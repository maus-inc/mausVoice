import { isFiniteAudioSample } from "./audio-samples.utils";

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
// Bound memory even if an invalid capture rate or option reaches this utility.
const MAX_STARTUP_SAMPLES = 30 * 384_000;

const sampleBudget = (seconds: number, sampleRate: number): number =>
  Math.min(
    MAX_STARTUP_SAMPLES,
    Math.max(1, Math.ceil(seconds * Math.max(sampleRate, 1))),
  );

export const createAudioChunkStartupBuffer = (
  onOverflow?: (droppedSamples: number) => void,
  maxStartupSeconds = DEFAULT_MAX_STARTUP_SECONDS,
  initialSampleRate = ASSUMED_STARTUP_SAMPLE_RATE,
): AudioChunkStartupBuffer => {
  const startupSeconds = Number.isFinite(maxStartupSeconds)
    ? maxStartupSeconds
    : DEFAULT_MAX_STARTUP_SECONDS;
  const startingRate = Number.isFinite(initialSampleRate)
    ? initialSampleRate
    : ASSUMED_STARTUP_SAMPLE_RATE;
  let maxSamples = sampleBudget(startupSeconds, startingRate);
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
      const remaining = maxSamples - pendingSamples;
      const retained = Math.min(samples.length, Math.max(0, remaining));
      if (retained === 0) {
        droppedSamples += samples.length;
        onOverflow?.(samples.length);
        return;
      }
      // Copy only the portion that fits. Converting the entire incoming array
      // first can allocate arbitrarily more than the buffer's configured cap.
      const copy = new Float32Array(retained);
      for (let i = 0; i < retained; i++) {
        const sample = samples[i];
        if (!isFiniteAudioSample(sample)) {
          droppedSamples += samples.length;
          onOverflow?.(samples.length);
          return;
        }
        copy[i] = sample;
      }
      const dropped = samples.length - retained;
      if (dropped > 0) {
        droppedSamples += dropped;
        onOverflow?.(dropped);
      }
      pendingChunks.push({ samples: copy, offset });
      pendingSamples += retained;
    },
    setSink: (nextSink) => {
      sink = nextSink;
    },
    setSampleRate: (sampleRate) => {
      // Ignore invalid rates instead of replacing the bounded budget with NaN
      // or infinity. The last known budget remains safe until a valid rate arrives.
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
      maxSamples = sampleBudget(startupSeconds, sampleRate);
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
