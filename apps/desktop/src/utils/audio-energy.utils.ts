import type { AudioSamples } from "../types/audio.types";

const toFloat32 = (
  samples: Exclude<AudioSamples, null | undefined>,
): Float32Array =>
  samples instanceof Float32Array ? samples : Float32Array.from(samples);

/**
 * Root-mean-square energy of PCM samples in the -1..1 float range.
 *
 * Used to detect near-silent audio before sending it to a cloud provider.
 * Whisper-like models are biased by their prompt: on silence they frequently
 * emit words from that prompt (for us, the user's dictionary/glossary).
 * A local energy gate is language- and provider-independent, so it catches
 * the case the `no_speech_prob` gate cannot: providers like Gemini that
 * return no verbose segments at all.
 */
export const computeRms = (samples: AudioSamples): number => {
  if (!samples || samples.length === 0) return 0;
  const input = toFloat32(samples);
  if (input.length === 0) return 0;
  let sumSquares = 0;
  for (const v of input) {
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / input.length);
};

/**
 * Peak absolute amplitude in -1..1. A pure-noise gate based on RMS alone
 * can miss a clipped burst; peak gives a second signal.
 */
export const computePeak = (samples: AudioSamples): number => {
  if (!samples || samples.length === 0) return 0;
  const input = toFloat32(samples);
  let peak = 0;
  for (const v of input) {
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  return peak;
};

/**
 * Maximum RMS over non-overlapping windows of `windowMs`. A whole recording
 * that is silent except for a single key click should not be treated as
 * containing speech; conversely a recording with one quiet but real
 * utterance must not be gated because its global average is low. Taking
 * the loudest window answers "was there any sustained speech-length
 * energy anywhere in this clip".
 */
export const maxWindowedRms = (
  samples: AudioSamples,
  sampleRate: number,
  windowMs = 300,
): number => {
  if (!samples || samples.length === 0 || sampleRate <= 0) return 0;
  const input = toFloat32(samples);
  if (input.length === 0) return 0;
  const windowSize = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  let max = 0;
  for (let start = 0; start < input.length; start += windowSize) {
    const end = Math.min(start + windowSize, input.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const v = input[i] ?? 0;
      sumSquares += v * v;
    }
    const windowRms = Math.sqrt(sumSquares / (end - start));
    if (windowRms > max) max = windowRms;
  }
  return max;
};

/**
 * Conservative "this audio is effectively silent" decision.
 *
 * Thresholds are deliberately low. Normal speech held a normal microphone
 * distance sits well above an RMS of 0.01; room tone and self-noise are
 * typically below 0.005. The peak guard prevents a single transient from
 * rescuing an otherwise dead clip: sustained speech always has both RMS and
 * a peak above these levels, while a mic bump has a high peak but no
 * sustained energy and is already caught by the windowed RMS.
 */
export const SILENCE_RMS_THRESHOLD = 0.006;
export const SILENCE_PEAK_THRESHOLD = 0.02;

export type SilenceDecision = {
  silent: boolean;
  rms: number;
  peak: number;
  maxWindowRms: number;
};

export const analyzeSilence = (
  samples: AudioSamples,
  sampleRate: number,
): SilenceDecision => {
  if (!samples || samples.length === 0) {
    return { silent: true, rms: 0, peak: 0, maxWindowRms: 0 };
  }
  const rms = computeRms(samples);
  const peak = computePeak(samples);
  const maxWindowRms = maxWindowedRms(samples, sampleRate);
  // Require BOTH low sustained energy (global and loudest window) and a low
  // peak before declaring silence, so quiet-but-real speech is never dropped.
  const silent =
    maxWindowRms < SILENCE_RMS_THRESHOLD &&
    rms < SILENCE_RMS_THRESHOLD &&
    peak < SILENCE_PEAK_THRESHOLD;
  return { silent, rms, peak, maxWindowRms };
};
