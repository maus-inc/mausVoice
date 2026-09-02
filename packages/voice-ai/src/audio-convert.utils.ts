export const convertFloat32ToPCM16 = (
  float32Array: Float32Array | number[],
): ArrayBuffer => {
  const samples = Array.isArray(float32Array)
    ? float32Array
    : Array.from(float32Array);
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
};

export const convertFloat32ToBase64PCM16 = (
  float32Array: Float32Array | number[],
): string => {
  const pcm16 = convertFloat32ToPCM16(float32Array);
  const bytes = new Uint8Array(pcm16);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};
