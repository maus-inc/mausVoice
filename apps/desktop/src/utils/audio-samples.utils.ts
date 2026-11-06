export const isFiniteAudioSample = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isFinite(Math.fround(value));

// The index loop is deliberate: callers type their chunks as `ArrayLike<number>`
// (some are typed-array views, some are plain arrays), so `for...of` is not
// available at the type level and `Array.from` would copy every recorded sample.
export function hasFiniteAudioSamples(samples: ArrayLike<number>): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (!isFiniteAudioSample(samples[index])) return false;
  }
  return true;
}

export const AUDIO_CHECKSUM_SEED = 0x811c9dc5;

/** Incremental FNV-1a over floats, treating signed zero as the same sample. */
export function checksumFloatSamples(
  samples: Float32Array,
  initial = AUDIO_CHECKSUM_SEED,
): number {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let hash = initial;
  for (let sample = 0; sample < samples.length; sample += 1) {
    const start = sample * 4;
    const zero = samples[sample] === 0;
    for (let index = 0; index < 4; index += 1) {
      hash = Math.imul(hash ^ (zero ? 0 : bytes[start + index]), 0x01000193);
    }
  }
  return hash >>> 0;
}

/** Hash array payloads in fixed-size blocks without copying a whole recording. */
export function checksumRecordingSamples(
  samples: number[] | Float32Array,
): number | null {
  if (samples instanceof Float32Array) {
    return hasFiniteAudioSamples(samples)
      ? checksumFloatSamples(samples)
      : null;
  }
  const block = new Float32Array(Math.min(samples.length, 4096));
  let hash = AUDIO_CHECKSUM_SEED;
  for (let start = 0; start < samples.length; start += block.length) {
    const count = Math.min(block.length, samples.length - start);
    for (let index = 0; index < count; index += 1) {
      const value = samples[start + index];
      if (!isFiniteAudioSample(value)) return null;
      block[index] = value;
    }
    hash = checksumFloatSamples(block.subarray(0, count), hash);
  }
  return hash;
}
