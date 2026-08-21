export const formatDuration = (durationMs?: number | null): string => {
  if (!durationMs || !Number.isFinite(durationMs)) {
    return "0:00";
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const createSeededRandom = (seed: number) => {
  let value = seed % 2147483647;
  if (value <= 0) {
    value += 2147483646;
  }

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
};

export const DEFAULT_WAVEFORM_BAR_COUNT = 58;
export const MIN_WAVEFORM_BAR_VALUE = 0.05;
export const MIN_COMPUTED_BAR_COUNT = 24;
export const MAX_COMPUTED_BAR_COUNT = 120;
export const WAVEFORM_BAR_MIN_WIDTH = 2;
export const WAVEFORM_BAR_MAX_WIDTH = 4;
export const WAVEFORM_BAR_GAP = 2;

export type PlaybackStopReason = "ended" | "stopped" | "replaced";

export type ActiveWebAudioPlayback = {
  transcriptionId: string;
  context: AudioContext;
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  rafId: number | null;
  startTime: number;
  offsetSeconds: number;
  durationSeconds: number;
  onProgress: (progress: number) => void;
  onStop: (reason: PlaybackStopReason) => void;
};

export let activePlayback: ActiveWebAudioPlayback | null = null;

const elapsedRatio = (playback: ActiveWebAudioPlayback): number => {
  const elapsed =
    playback.context.currentTime - playback.startTime + playback.offsetSeconds;
  if (playback.durationSeconds <= 0) {
    return 0;
  }
  return Math.min(Math.max(elapsed / playback.durationSeconds, 0), 1);
};

export const clampPlaybackProgress = (progress: number): number =>
  Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;

const armTick = (playback: ActiveWebAudioPlayback): void => {
  const tick = () => {
    if (activePlayback !== playback) {
      return;
    }

    const ratio = elapsedRatio(playback);
    playback.onProgress(ratio);

    if (ratio >= 1) {
      return;
    }

    playback.rafId = window.requestAnimationFrame(tick);
  };

  if (playback.rafId !== null) {
    window.cancelAnimationFrame(playback.rafId);
  }
  playback.rafId = window.requestAnimationFrame(tick);
};

const startSourceAt = (
  playback: ActiveWebAudioPlayback,
  offsetSeconds: number,
): void => {
  const source = playback.context.createBufferSource();
  source.buffer = playback.buffer;
  source.connect(playback.context.destination);
  source.onended = () => {
    if (activePlayback === playback) {
      stopActivePlayback("ended");
    }
  };
  playback.source = source;
  playback.offsetSeconds = offsetSeconds;
  playback.startTime = playback.context.currentTime;
  source.start(0, offsetSeconds);
};

export const stopActivePlayback = (reason: PlaybackStopReason): void => {
  const current = activePlayback;
  if (!current) {
    return;
  }

  activePlayback = null;

  if (current.rafId !== null) {
    window.cancelAnimationFrame(current.rafId);
  }

  try {
    current.source.onended = null;
  } catch {
    // no-op
  }

  try {
    current.source.stop();
  } catch {
    // no-op
  }

  try {
    current.source.disconnect();
  } catch {
    // no-op
  }

  current.context.close().catch(() => undefined);
  current.onStop(reason);
};

export const seekPlayback = (progress: number): boolean => {
  const playback = activePlayback;
  if (!playback || playback.durationSeconds <= 0) {
    return false;
  }

  const ratio = clampPlaybackProgress(progress);
  const offsetSeconds = ratio * playback.durationSeconds;

  try {
    playback.source.onended = null;
  } catch {
    // no-op
  }
  try {
    playback.source.stop();
  } catch {
    // source already stopped
  }
  try {
    playback.source.disconnect();
  } catch {
    // already disconnected
  }

  startSourceAt(playback, offsetSeconds);
  playback.onProgress(ratio);
  armTick(playback);
  return true;
};

export const playWebAudio = async (
  transcriptionId: string,
  data: { samples: number[]; sampleRate: number },
  onProgress: (progress: number) => void,
  onStop: (reason: PlaybackStopReason) => void,
  startProgress = 0,
): Promise<void> => {
  stopActivePlayback("replaced");

  const context = new AudioContext({ sampleRate: data.sampleRate });
  if (context.state === "suspended") {
    await context.resume();
  }

  const channelCount = 1;
  const floatSamples = Float32Array.from(data.samples ?? []);
  const buffer = context.createBuffer(
    channelCount,
    floatSamples.length,
    data.sampleRate,
  );
  buffer.getChannelData(0).set(floatSamples);

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);

  const playback: ActiveWebAudioPlayback = {
    transcriptionId,
    context,
    source,
    buffer,
    rafId: null,
    startTime: context.currentTime,
    offsetSeconds: 0,
    durationSeconds: buffer.duration,
    onProgress,
    onStop,
  };
  activePlayback = playback;

  source.onended = () => {
    if (activePlayback === playback) {
      stopActivePlayback("ended");
    }
  };

  const startRatio = clampPlaybackProgress(startProgress);
  if (buffer.duration <= 0 || startRatio >= 1) {
    onProgress(1);
    stopActivePlayback("ended");
    return;
  }

  const offset = startRatio * buffer.duration;
  playback.offsetSeconds = offset;
  playback.startTime = context.currentTime;
  onProgress(startRatio);
  source.start(0, offset);
  armTick(playback);
};

/** Deterministic decorative bars — not PCM peaks. Same seed → same silhouette. */
export const buildWaveformOutline = (
  seedKey: string,
  durationMs?: number | null,
  points = 28,
): number[] => {
  if (points <= 0) {
    return [];
  }

  const durationSeed = Math.round((durationMs ?? 0) / 37);
  const stringSeed = seedKey
    .split("")
    .reduce(
      (accumulator, character) => accumulator + character.charCodeAt(0),
      0,
    );
  const combinedSeed = stringSeed * 31 + durationSeed * 17 || 1;
  const random = createSeededRandom(combinedSeed);

  return Array.from({ length: points }, (_, index) => {
    const t = points <= 1 ? 0 : index / (points - 1);
    const eased = Math.pow(t, 0.85);
    const envelope = Math.sin(Math.PI * eased);
    const modulation = 0.45 + random() * 0.55;
    const baseline = 0.12 + random() * 0.2;
    return Math.max(0.12, Math.min(1, envelope * modulation + baseline));
  });
};
