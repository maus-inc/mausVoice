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
let closingContext: Promise<void> | null = null;
let playbackGeneration = 0;

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

export const stopActivePlayback = (reason: PlaybackStopReason): void => {
  // A stop is a claim on the generation as well as on whatever is playing.
  // `playWebAudio` publishes `activePlayback` only once every await has
  // settled, so a stop pressed while it is still suspended — inside
  // `resume()`, or waiting on a previous context to close — finds nothing to
  // tear down and used to return early. Advancing the generation is what tells
  // that suspended call it has been superseded: the guard it checks on
  // resumption still compared equal otherwise, so the audio started playing
  // after the user had asked for it to stop.
  playbackGeneration += 1;

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

  closingContext = current.context.close().catch(() => undefined);
  current.onStop(reason);
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
  // Replacing the previous playback first, and reading the generation after it,
  // because that stop advances the generation itself. Capturing it beforehand
  // would make every call supersede its own request.
  stopActivePlayback("replaced");
  const generation = ++playbackGeneration;
  if (closingContext) {
    await closingContext;
    if (generation === playbackGeneration) {
      closingContext = null;
    }
  }

  // Superseded while awaiting `closingContext`. `onStop` still has to fire: the caller sets
  // `isPlaying` true BEFORE awaiting this function, and `activePlayback` only takes ownership
  // further down, so a newer `stopActivePlayback("replaced")` finds nothing to stop and never
  // reaches this call's `onStop`. Returning quietly leaves the row showing "playing" forever.
  if (generation !== playbackGeneration) {
    onStop("replaced");
    return;
  }

  const context = new AudioContext({ sampleRate: data.sampleRate });

  // An AudioContext holds an OS audio handle, and `activePlayback` only takes
  // ownership of this one after every await below has settled. An exit between
  // the allocation and that hand-off — a rejected `resume()`, or a
  // `createBuffer` that rejects the sample rate — propagates out of here with
  // no owner left to close it, so the handle survives until the page unloads.
  // The caller recovers from such a rejection by showing an error snackbar, and
  // playback is started per transcription row, so these accumulate. Close on
  // every exit from this window that has not handed the context over.
  let ownedByActivePlayback = false;
  try {
    if (context.state === "suspended") {
      await context.resume();
    }

    // Same reasoning as the exit above: superseded after `resume()`, before ownership.
    if (generation !== playbackGeneration) {
      onStop("replaced");
      return;
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
    ownedByActivePlayback = true;

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
  } catch (error) {
    // The far side of that hand-off. Setting up the playback is also what
    // schedules its teardown, and neither half of that has run on an exit from
    // here: `source.onended` fires only for a source that actually started, and
    // `armTick` runs last. So an exception from `onProgress` or `source.start`
    // leaves an open context under a stale `activePlayback` -- the same handle
    // leak the `finally` closes, reached by the other route. Releasing it here
    // is the only thing that both closes the context and clears the owner; the
    // caller recovers from the rejection by showing an error snackbar, so
    // nothing else would come back for it.
    if (ownedByActivePlayback) {
      // Best-effort, like the close below: a teardown that throws must not
      // replace the failure the caller is about to be told about.
      try {
        stopActivePlayback("stopped");
      } catch {
        // no-op
      }
    }
    throw error;
  } finally {
    if (!ownedByActivePlayback) {
      context.close().catch(() => undefined);
    }
  }
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
