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
