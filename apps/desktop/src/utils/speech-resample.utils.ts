/**
 * Speech ASR models (Whisper, Parakeet, Nova, Universal, Scribe) consume
 * 16 kHz mono. Uploading 44.1/48 kHz PCM sends 3x the bytes for no accuracy
 * gain, and upload time dominates cloud transcription wait on typical uplinks.
 */
export const SPEECH_SAMPLE_RATE = 16_000;

const ZERO_CROSSINGS = 8;
const CUTOFF_RATIO = 0.94;
const MAX_PHASES = 1_024;
const MAX_FILTER_RADIUS = 2_048;
const MAX_FILTER_COEFFICIENTS = 1_000_000;

type PolyphaseTable = {
  up: number;
  down: number;
  radius: number;
  phases: Float32Array[];
};

const tableCache = new Map<string, PolyphaseTable | null>();

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const blackman = (x: number, halfWidth: number): number => {
  const ratio = (x + halfWidth) / (2 * halfWidth);
  return (
    0.42 -
    0.5 * Math.cos(2 * Math.PI * ratio) +
    0.08 * Math.cos(4 * Math.PI * ratio)
  );
};

const buildTable = (
  inputRate: number,
  outputRate: number,
): PolyphaseTable | null => {
  const divisor = gcd(inputRate, outputRate);
  const up = outputRate / divisor;
  const down = inputRate / divisor;
  if (up > MAX_PHASES) {
    return null;
  }
  // Cutoff in cycles per input sample, just under the output Nyquist.
  const cutoff = (0.5 * CUTOFF_RATIO * outputRate) / inputRate;
  const halfWidth = ZERO_CROSSINGS / (2 * cutoff);
  const radius = Math.ceil(halfWidth);
  if (
    radius > MAX_FILTER_RADIUS ||
    (2 * radius + 1) * up > MAX_FILTER_COEFFICIENTS
  ) {
    return null;
  }
  const phases: Float32Array[] = [];
  for (let phase = 0; phase < up; phase += 1) {
    const fraction = phase / up;
    const taps = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const distance = k - fraction;
      if (Math.abs(distance) > halfWidth) continue;
      const x = 2 * cutoff * distance;
      const sinc =
        Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const weight = sinc * blackman(distance, halfWidth);
      taps[k + radius] = weight;
      sum += weight;
    }
    for (let index = 0; index < taps.length; index += 1) {
      taps[index] /= sum;
    }
    phases.push(taps);
  }
  return { up, down, radius, phases };
};

const getTable = (
  inputRate: number,
  outputRate: number,
): PolyphaseTable | null => {
  const key = `${inputRate}:${outputRate}`;
  if (!tableCache.has(key)) {
    tableCache.set(key, buildTable(inputRate, outputRate));
  }
  return tableCache.get(key) ?? null;
};

/**
 * One filter tap set applied at `start`. Near the clip edges the missing
 * taps are dropped and the rest renormalized, so DC is preserved.
 */
const convolveAt = (
  samples: Float32Array,
  start: number,
  taps: Float32Array,
): number => {
  if (start >= 0 && start + taps.length <= samples.length) {
    let acc = 0;
    for (let tap = 0; tap < taps.length; tap += 1) {
      acc += samples[start + tap] * taps[tap];
    }
    return acc;
  }
  const first = Math.max(0, -start);
  const end = Math.min(taps.length, samples.length - start);
  let acc = 0;
  let weight = 0;
  for (let tap = first; tap < end; tap += 1) {
    acc += samples[start + tap] * taps[tap];
    weight += taps[tap];
  }
  return Math.abs(weight) > 1e-12 ? acc / weight : 0;
};

/**
 * Shared admission for both downsamplers: the rates must be safe integers, the
 * conversion must actually downsample, and the ratio must fit a filter table.
 */
const resolveDownsampleTable = (
  inputRate: number,
  outputRate: number,
): PolyphaseTable | null => {
  if (
    !Number.isSafeInteger(inputRate) ||
    !Number.isSafeInteger(outputRate) ||
    inputRate <= outputRate ||
    outputRate <= 0
  ) {
    return null;
  }
  return getTable(inputRate, outputRate);
};

/**
 * Streaming equivalent of the speech downsampler. Keep enough lookahead for
 * the same band-limited filter, then flush the right edge when capture ends.
 */
export const createStreamingSpeechDownsampler = (
  inputRate: number,
  outputRate: number = SPEECH_SAMPLE_RATE,
): {
  process: (input: Float32Array) => Float32Array;
  flush: () => Float32Array;
  reset: () => void;
} | null => {
  const table = resolveDownsampleTable(inputRate, outputRate);
  if (!table) return null;
  const { up, down, radius, phases } = table;
  let buffer = new Float32Array(0);
  let bufferStart = 0;
  let totalInput = 0;
  let nextOutput = 0;

  const reset = () => {
    buffer = new Float32Array(0);
    bufferStart = 0;
    totalInput = 0;
    nextOutput = 0;
  };
  const drain = (flush: boolean): Float32Array => {
    const count = Math.floor((totalInput * up) / down);
    const output: number[] = [];
    while (nextOutput < count) {
      const position = nextOutput * down;
      const center = Math.floor(position / up);
      if (!flush && center + radius >= totalInput) break;
      output.push(
        convolveAt(
          buffer,
          center - radius - bufferStart,
          phases[position % up],
        ),
      );
      nextOutput += 1;
    }
    const nextCenter = Math.floor((nextOutput * down) / up);
    const consumed = Math.min(
      buffer.length,
      Math.max(0, nextCenter - radius - bufferStart),
    );
    if (consumed) {
      buffer = buffer.slice(consumed);
      bufferStart += consumed;
    }
    const result = Float32Array.from(output);
    if (flush) reset();
    return result;
  };
  return {
    process: (input) => {
      if (!input.length) return new Float32Array(0);
      const combined = new Float32Array(buffer.length + input.length);
      combined.set(buffer);
      combined.set(input, buffer.length);
      buffer = combined;
      totalInput += input.length;
      return drain(false);
    },
    flush: () => drain(true),
    reset,
  };
};

/**
 * Anti-aliased downsampling to `outputRate`. Returns `null` when the input is
 * already at or below the target rate, or when the rate ratio would need an
 * oversized filter table; callers then keep the original samples.
 */
export const downsampleForSpeech = (
  samples: Float32Array,
  inputRate: number,
  outputRate: number = SPEECH_SAMPLE_RATE,
): Float32Array | null => {
  const table = resolveDownsampleTable(inputRate, outputRate);
  if (!table) return null;

  const { up, down, radius, phases } = table;
  const outputLength = Math.floor((samples.length * up) / down);
  const output = new Float32Array(outputLength);
  for (let outIndex = 0; outIndex < outputLength; outIndex += 1) {
    const position = outIndex * down;
    const start = Math.floor(position / up) - radius;
    output[outIndex] = convolveAt(samples, start, phases[position % up]);
  }
  return output;
};
