/** Convert duration bounds to sample counts, retaining at least one sample. */
export const audioChunkSampleBounds = (
  sampleRate: number,
  minChunkDurationMs: number,
  maxChunkDurationMs: number,
): { minSamplesPerChunk: number; maxSamplesPerChunk: number } => {
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * minChunkDurationMs) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * maxChunkDurationMs) / 1000),
  );
  return { minSamplesPerChunk, maxSamplesPerChunk };
};

export const drainSamples = (
  pendingChunks: Float32Array[],
  pendingSampleCount: { value: number },
  targetCount: number,
): Float32Array => {
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

  pendingSampleCount.value = Math.max(0, pendingSampleCount.value - filled);
  return filled === targetCount ? output : output.subarray(0, filled);
};

/** Pad only a nonempty, forced final chunk to the provider's minimum size. */
export const padFinalAudioChunk = (
  chunk: Float32Array,
  minSamples: number,
  force: boolean,
): Float32Array => {
  if (!force || chunk.length === 0 || chunk.length >= minSamples) return chunk;
  const padded = new Float32Array(minSamples);
  padded.set(chunk);
  return padded;
};
