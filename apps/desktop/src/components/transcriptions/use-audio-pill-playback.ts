import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { IntlShape } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTranscriptionRepo } from "../../repos";
import {
  playWebAudio,
  type PlaybackStopReason,
} from "../../utils/audio-playback.utils";
import { subscribeToLocalDataClearRequested } from "../../utils/local-data-write-gate";
import {
  createAudioPillPlaybackSession,
  type AudioPillPlaybackAttempt,
  type AudioPillPlaybackSession,
} from "./audio-pill-playback-session";

const markAudioReadStart = () => {
  if (!import.meta.env.DEV) return;
  // Clear before marking: User Timing entries otherwise accumulate for the
  // window's lifetime on every development playback. One live entry per name
  // is all the DEV timing needs.
  performance.clearMarks("mv-audio:read-start");
  performance.clearMarks("mv-audio:read-end");
  performance.clearMeasures("mv-audio:read");
  performance.mark("mv-audio:read-start");
};

const markAudioReadEnd = () => {
  if (!import.meta.env.DEV) return;
  performance.mark("mv-audio:read-end");
  performance.measure(
    "mv-audio:read",
    "mv-audio:read-start",
    "mv-audio:read-end",
  );
};

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name?: string }).name === "AbortError";

export type AudioPillPlaybackState = {
  isPlaying: boolean;
  isLoading: boolean;
  playbackProgress: number;
  isPlayingRef: RefObject<boolean>;
  loadingRef: RefObject<boolean>;
  progressRef: RefObject<number>;
  setPlaying: (playing: boolean) => void;
  setLoading: (loading: boolean) => void;
  setProgress: (progress: number) => void;
  reset: (options?: { progress?: boolean }) => void;
  getSession: () => AudioPillPlaybackSession;
};

/**
 * The playing/loading/progress triple, each mirrored into a ref so async
 * callbacks read the current value instead of the render they closed over.
 */
const useAudioPillPlaybackState = ({
  transcriptionId,
  disabled,
}: {
  transcriptionId: string;
  disabled: boolean | undefined;
}): AudioPillPlaybackState => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const isPlayingRef = useRef(false);
  const loadingRef = useRef(false);
  const progressRef = useRef(0);
  const sessionRef = useRef<AudioPillPlaybackSession | null>(null);

  const getSession = () => {
    sessionRef.current ??= createAudioPillPlaybackSession();
    return sessionRef.current;
  };

  const setPlaying = useCallback((playing: boolean) => {
    isPlayingRef.current = playing;
    setIsPlaying(playing);
  }, []);
  const setLoading = useCallback((loading: boolean) => {
    loadingRef.current = loading;
    setIsLoading(loading);
  }, []);
  const setProgress = useCallback((progress: number) => {
    progressRef.current = progress;
    setPlaybackProgress(progress);
  }, []);
  // One reset for every teardown path so the playing/loading flags cannot
  // drift apart between call sites; only the sites that own the scrub bar
  // ask for the progress reset.
  const reset = useCallback(
    ({ progress = false }: { progress?: boolean } = {}) => {
      isPlayingRef.current = false;
      setIsPlaying(false);
      loadingRef.current = false;
      setIsLoading(false);
      if (progress) {
        progressRef.current = 0;
        setPlaybackProgress(0);
      }
    },
    [],
  );

  useAudioPillLifecycle({ transcriptionId, disabled, reset, getSession });

  return {
    isPlaying,
    isLoading,
    playbackProgress,
    isPlayingRef,
    loadingRef,
    progressRef,
    setPlaying,
    setLoading,
    setProgress,
    reset,
    getSession,
  };
};

const useAudioPillLifecycle = ({
  transcriptionId,
  disabled,
  reset,
  getSession,
}: {
  transcriptionId: string;
  disabled: boolean | undefined;
  reset: AudioPillPlaybackState["reset"];
  getSession: () => AudioPillPlaybackSession;
}) => {
  useEffect(() => {
    return () => {
      getSession().stopOwned();
    };
  }, [transcriptionId]);

  // A row that re-renders with a new transcription id is a different clip:
  // drop the old clip's playback/scrub state so the next click plays the new
  // read and the scrub bar cannot commit a seek against the old session.
  useEffect(() => {
    reset({ progress: true });
  }, [transcriptionId, reset]);

  useEffect(() => {
    if (!disabled || !getSession().stopOwned()) return;
    reset();
  }, [disabled, reset]);

  // A local-data wipe must drop in-flight and active audio with the rows it
  // invalidates; the repo clears its cache through the same subscription.
  useEffect(() => {
    return subscribeToLocalDataClearRequested(() => {
      getSession().stopOwned();
      reset({ progress: true });
    });
  }, [transcriptionId]);
};

/** The per-attempt callbacks the player hands to `playWebAudio`. */
const useAudioPillAttemptCallbacks = ({
  state,
  transcriptionIdRef,
  isDraggingRef,
}: {
  state: AudioPillPlaybackState;
  transcriptionIdRef: RefObject<string>;
  isDraggingRef: RefObject<boolean>;
}) => {
  const { setPlaying, setProgress, reset } = state;
  const latestAttemptRef = useRef<AudioPillPlaybackAttempt | null>(null);

  const applyProgress = useCallback(
    (progress: number, attempt: AudioPillPlaybackAttempt, id: string) => {
      if (
        transcriptionIdRef.current === id &&
        attempt.isNonceCurrent() &&
        !isDraggingRef.current
      ) {
        setProgress(progress);
      }
    },
    [isDraggingRef, setProgress, transcriptionIdRef],
  );

  const applyStop = useCallback(
    (
      reason: PlaybackStopReason,
      attempt: AudioPillPlaybackAttempt,
      id: string,
    ) => {
      if (
        transcriptionIdRef.current !== id ||
        !attempt.handleStopCallback(reason)
      ) {
        return;
      }
      setPlaying(false);
      if (reason === "ended") setProgress(0);
    },
    [setPlaying, setProgress, transcriptionIdRef],
  );

  const clearStaleRowFlags = useCallback(
    (attempt: AudioPillPlaybackAttempt) => {
      // A stale attempt may only clear loading flags that belong to itself,
      // never a newer attempt's on the same row.
      if (latestAttemptRef.current === attempt) reset();
    },
    [reset],
  );

  return { applyProgress, applyStop, clearStaleRowFlags, latestAttemptRef };
};

const reportPlaybackFailure = (
  intl: IntlShape,
  error: unknown,
  stage: "read" | "play",
) => {
  // Abandoned work (row torn down, read invalidated mid-flight) rejects
  // with AbortError; the owner already reset the row, so stay silent.
  if (isAbortError(error)) return;
  console.error("Failed to toggle audio playback", error);
  // Two literal message calls, one per failing stage (read vs play), so the
  // extraction pipeline sees both messages.
  showErrorSnackbar(
    stage === "read"
      ? intl.formatMessage({
          defaultMessage: "The saved audio for this entry is unavailable.",
        })
      : intl.formatMessage({
          defaultMessage: "Unable to play audio snippet.",
        }),
  );
};

export type AudioPillPlayback = {
  isPlaying: boolean;
  isLoading: boolean;
  playbackProgress: number;
  isPlayingRef: RefObject<boolean>;
  isDraggingRef: RefObject<boolean>;
  progressRef: RefObject<number>;
  setProgress: (progress: number) => void;
  togglePlayback: () => Promise<void>;
};

export const useAudioPillPlayback = ({
  transcriptionId,
  disabled,
  intl,
}: {
  transcriptionId: string;
  disabled: boolean | undefined;
  intl: IntlShape;
}): AudioPillPlayback => {
  const state = useAudioPillPlaybackState({ transcriptionId, disabled });
  const {
    setPlaying,
    setLoading,
    setProgress,
    reset,
    getSession,
    loadingRef,
    progressRef,
  } = state;
  const isDraggingRef = useRef(false);

  const transcriptionIdRef = useRef(transcriptionId);
  useEffect(() => {
    transcriptionIdRef.current = transcriptionId;
  }, [transcriptionId]);

  const { applyProgress, applyStop, clearStaleRowFlags, latestAttemptRef } =
    useAudioPillAttemptCallbacks({ state, transcriptionIdRef, isDraggingRef });

  const togglePlayback = useCallback(async () => {
    const session = getSession();
    if (state.isPlayingRef.current) {
      session.stopOwned();
      setPlaying(false);
      return;
    }
    if (loadingRef.current) {
      // The button reads "Cancel audio loading" while a read is pending;
      // clicking it abandons that read instead of stacking another one.
      session.stopOwned();
      reset();
      return;
    }

    const attempt = session.beginRequest();
    // Identity of the newest attempt on this row: a stale attempt may only
    // clear loading state that belongs to itself, never a newer attempt's.
    latestAttemptRef.current = attempt;
    setLoading(true);
    // The error state names the stage that failed: a read failure (missing or
    // invalid file) is a different recovery than a decode/playback failure.
    let stage: "read" | "play" = "read";
    try {
      markAudioReadStart();
      const audioData =
        await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
      markAudioReadEnd();

      if (!attempt.isCurrent()) {
        clearStaleRowFlags(attempt);
        return;
      }
      stage = "play";

      setLoading(false);
      setPlaying(true);
      attempt.beginSetup();
      await playWebAudio(
        transcriptionId,
        audioData,
        (progress) => applyProgress(progress, attempt, transcriptionId),
        (reason) => applyStop(reason, attempt, transcriptionId),
        progressRef.current,
        attempt.signal,
      );
      attempt.completeSetup();
    } catch (error) {
      if (!attempt.releaseOnError()) {
        clearStaleRowFlags(attempt);
        return;
      }
      reset({ progress: true });
      reportPlaybackFailure(intl, error, stage);
    }
  }, [
    applyProgress,
    applyStop,
    clearStaleRowFlags,
    getSession,
    intl,
    loadingRef,
    progressRef,
    reset,
    setLoading,
    setPlaying,
    state.isPlayingRef,
    transcriptionId,
  ]);

  return {
    isPlaying: state.isPlaying,
    isLoading: state.isLoading,
    playbackProgress: state.playbackProgress,
    isPlayingRef: state.isPlayingRef,
    isDraggingRef,
    progressRef,
    setProgress,
    togglePlayback,
  };
};
