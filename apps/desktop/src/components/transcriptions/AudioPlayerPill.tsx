import { Box, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useIntentWarmup } from "../../hooks/intent-warmup.hooks";
import { subscribeToLocalDataClearRequested } from "../../utils/local-data-write-gate";
import { transcriptionAudioCache } from "../../utils/transcription-audio-cache";
import { AudioPlaybackButton } from "./AudioPlaybackButton";
import { AudioWaveformBars } from "./AudioWaveformBars";
import {
  type AudioPillPlaybackSession,
  createAudioPillPlaybackSession,
} from "./audio-pill-playback-session";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTranscriptionRepo } from "../../repos";
import {
  buildWaveformOutline,
  DEFAULT_WAVEFORM_BAR_COUNT,
  formatDuration,
  MAX_COMPUTED_BAR_COUNT,
  MIN_COMPUTED_BAR_COUNT,
  MIN_WAVEFORM_BAR_VALUE,
  playWebAudio,
  seekPlayback,
  WAVEFORM_BAR_GAP,
  WAVEFORM_BAR_MAX_WIDTH,
  WAVEFORM_BAR_MIN_WIDTH,
} from "../../utils/audio-playback.utils";

export type AudioPlayerPillProps = {
  transcriptionId: string;
  durationMs?: number | null;
  disabled?: boolean;
  actions?: React.ReactNode;
};

export const AudioPlayerPill = ({
  transcriptionId,
  durationMs,
  disabled,
  actions,
}: AudioPlayerPillProps) => {
  const intl = useIntl();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const loadingRef = useRef(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const playbackSessionRef = useRef<AudioPillPlaybackSession | null>(null);
  const getPlaybackSession = () => {
    playbackSessionRef.current ??= createAudioPillPlaybackSession();
    return playbackSessionRef.current;
  };
  const isPlayingRef = useRef(false);
  const playbackProgressRef = useRef(0);
  const transcriptionIdRef = useRef(transcriptionId);
  const isDraggingRef = useRef(false);
  const progressAtDragStartRef = useRef(0);
  // One reset for every teardown path so the playing/loading flags cannot
  // drift apart between call sites; only the sites that own the scrub bar
  // ask for the progress reset.
  const resetPlaybackState = useCallback(
    ({ progress = false }: { progress?: boolean } = {}) => {
      isPlayingRef.current = false;
      setIsPlaying(false);
      loadingRef.current = false;
      setIsLoading(false);
      if (progress) setPlaybackProgress(0);
    },
    [],
  );
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  useEffect(() => {
    playbackProgressRef.current = playbackProgress;
  }, [playbackProgress]);
  useEffect(() => {
    transcriptionIdRef.current = transcriptionId;
  }, [transcriptionId]);
  const desiredWaveformBarCount = useMemo(() => {
    if (waveformWidth <= 0) {
      return DEFAULT_WAVEFORM_BAR_COUNT;
    }

    const gap = WAVEFORM_BAR_GAP;
    const availableWidth = waveformWidth;
    const approximateCount = Math.floor(
      (availableWidth + gap) / (WAVEFORM_BAR_MIN_WIDTH + gap),
    );

    return Math.max(
      MIN_COMPUTED_BAR_COUNT,
      Math.min(MAX_COMPUTED_BAR_COUNT, approximateCount),
    );
  }, [waveformWidth]);
  const waveformValues = useMemo(
    () =>
      buildWaveformOutline(
        transcriptionId,
        durationMs,
        desiredWaveformBarCount,
      ),
    [durationMs, desiredWaveformBarCount, transcriptionId],
  );
  const waveformBars = useMemo(() => {
    if (!waveformValues.length) {
      return Array.from(
        { length: desiredWaveformBarCount },
        () => MIN_WAVEFORM_BAR_VALUE,
      );
    }

    return waveformValues;
  }, [desiredWaveformBarCount, waveformValues]);
  const computedBarWidth = useMemo(() => {
    if (waveformWidth <= 0 || waveformBars.length === 0) {
      return WAVEFORM_BAR_MIN_WIDTH;
    }

    const totalGaps = WAVEFORM_BAR_GAP * Math.max(waveformBars.length - 1, 0);
    const availableForBars = Math.max(waveformWidth - totalGaps, 0);
    const widthPerBar = availableForBars / waveformBars.length;

    return Math.max(
      WAVEFORM_BAR_MIN_WIDTH,
      Math.min(WAVEFORM_BAR_MAX_WIDTH, widthPerBar),
    );
  }, [waveformBars.length, waveformWidth]);
  const progressPercent = Math.min(Math.max(playbackProgress, 0), 1) * 100;
  useEffect(() => {
    return () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      getPlaybackSession().stopOwned();
    };
  }, [transcriptionId]);
  // A row that re-renders with a new transcription id is a different clip:
  // drop the old clip's playback/scrub state so the next click plays the new
  // read and the scrub bar cannot commit a seek against the old session.
  useEffect(() => {
    resetPlaybackState({ progress: true });
  }, [transcriptionId, resetPlaybackState]);
  useEffect(() => {
    if (!disabled || !getPlaybackSession().stopOwned()) return;
    resetPlaybackState();
  }, [disabled, resetPlaybackState]);
  // A local-data wipe must drop in-flight and active audio with the rows it
  // invalidates; the repo clears its cache through the same subscription.
  useEffect(() => {
    return subscribeToLocalDataClearRequested(() => {
      getPlaybackSession().stopOwned();
      resetPlaybackState({ progress: true });
    });
  }, [transcriptionId]);
  // Hovering the pill warms the saved audio through the repository cache so
  // the first click starts from a warm read (the cache is TTL-bounded and
  // throttled; see transcription-audio-cache.ts).
  const warmAudio = useCallback(async () => {
    if (!disabled && transcriptionAudioCache.canWarm()) {
      await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
    }
  }, [disabled, transcriptionId]);
  const warmup = useIntentWarmup(warmAudio, transcriptionId);
  useEffect(() => {
    const element = waveformContainerRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setWaveformWidth(element.getBoundingClientRect().width);
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      if (typeof window !== "undefined") {
        window.addEventListener("resize", updateWidth);
        return () => window.removeEventListener("resize", updateWidth);
      }
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWaveformWidth(entry.contentRect.width);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [transcriptionId]);
  const handlePlaybackToggle = useCallback(async () => {
    const session = getPlaybackSession();
    if (isPlayingRef.current) {
      session.stopOwned();
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    if (loadingRef.current) {
      // The button reads "Cancel audio loading" while a read is pending;
      // clicking it abandons that read instead of stacking another one.
      session.stopOwned();
      resetPlaybackState();
      return;
    }

    const attempt = session.beginRequest();
    loadingRef.current = true;
    setIsLoading(true);
    // The error state names the stage that failed: a read failure (missing or
    // invalid file) is a different recovery than a decode/playback failure.
    let stage: "read" | "play" = "read";
    try {
      if (import.meta.env.DEV) {
        // Clear before marking: User Timing entries otherwise accumulate for
        // the window's lifetime on every development playback. One live entry
        // per name is all the DEV timing needs.
        performance.clearMarks("mv-audio:read-start");
        performance.clearMarks("mv-audio:read-end");
        performance.clearMeasures("mv-audio:read");
        performance.mark("mv-audio:read-start");
      }
      const audioData =
        await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
      if (import.meta.env.DEV) {
        performance.mark("mv-audio:read-end");
        performance.measure(
          "mv-audio:read",
          "mv-audio:read-start",
          "mv-audio:read-end",
        );
      }

      if (!attempt.isCurrent()) {
        // Ownership moved on (another pill took the session or the work was
        // abandoned): drop this row's loading flags so its button cannot stay
        // stuck on "Cancel audio loading" for work it no longer owns.
        resetPlaybackState();
        return;
      }
      stage = "play";

      loadingRef.current = false;
      setIsLoading(false);
      isPlayingRef.current = true;
      setIsPlaying(true);
      attempt.beginSetup();
      await playWebAudio(
        transcriptionId,
        audioData,
        (progress) => {
          if (
            transcriptionIdRef.current === transcriptionId &&
            attempt.isNonceCurrent() &&
            !isDraggingRef.current
          ) {
            setPlaybackProgress(progress);
          }
        },
        (reason) => {
          if (
            transcriptionIdRef.current !== transcriptionId ||
            !attempt.handleStopCallback(reason)
          ) {
            return;
          }
          isPlayingRef.current = false;
          setIsPlaying(false);
          if (reason === "ended") {
            setPlaybackProgress(0);
          }
        },
        playbackProgressRef.current,
        attempt.signal,
      );
      attempt.completeSetup();
    } catch (error) {
      if (!attempt.releaseOnError()) {
        // The abort/supersede path owns the state now; make sure this row is
        // not left loading for an attempt it no longer drives.
        resetPlaybackState();
        return;
      }
      resetPlaybackState({ progress: true });
      // Abandoned work (row torn down, read invalidated mid-flight) rejects
      // with AbortError; the owner already reset the row, so stay silent.
      const aborted =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: string }).name === "AbortError";
      if (aborted) return;
      console.error("Failed to toggle audio playback", error);
      // Two literal message calls, one per failing stage (read vs play), so
      // the extraction pipeline sees both messages.
      showErrorSnackbar(
        stage === "read"
          ? intl.formatMessage({
              defaultMessage: "The saved audio for this entry is unavailable.",
            })
          : intl.formatMessage({
              defaultMessage: "Unable to play audio snippet.",
            }),
      );
    }
  }, [transcriptionId, intl]);
  const durationLabel = formatDuration(durationMs);

  /** Scrub mapping from client X (same idea as elevenlabs-ui scrub-bar). Bars are a seeded silhouette, not live PCM. */
  const getProgressFromClientX = useCallback((clientX: number) => {
    const track = waveformContainerRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(Math.max(ratio, 0), 1);
  }, []);
  const previewSeek = useCallback((ratio: number) => {
    playbackProgressRef.current = ratio;
    setPlaybackProgress(ratio);
  }, []);
  const commitSeek = useCallback((ratio: number) => {
    playbackProgressRef.current = ratio;
    setPlaybackProgress(ratio);
    if (isPlayingRef.current) {
      seekPlayback(ratio);
    }
  }, []);
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      // Tear down any previous drag first: its endDrag clears the drag
      // flags and running it after the new state is set would clobber it.
      pointerCleanupRef.current?.();
      isDraggingRef.current = true;
      progressAtDragStartRef.current = playbackProgressRef.current;
      const next = getProgressFromClientX(event.clientX);
      if (next != null) previewSeek(next);

      // Listener lifetime is scoped to one AbortController so every exit
      // path (release, cancel, re-entrant drag, lifecycle cleanup) runs one
      // teardown and `isDraggingRef` can never outlive its listeners: a
      // stuck drag flag mutes playback progress for good.
      const dragListeners = new AbortController();
      const endDrag = () => {
        dragListeners.abort();
        pointerCleanupRef.current = null;
        isDraggingRef.current = false;
      };
      const handleMove = (moveEvent: PointerEvent) => {
        const ratio = getProgressFromClientX(moveEvent.clientX);
        if (ratio != null) previewSeek(ratio);
      };
      const handleUp = (upEvent: PointerEvent) => {
        endDrag();
        const ratio = getProgressFromClientX(upEvent.clientX);
        if (ratio != null) {
          commitSeek(ratio);
        } else {
          commitSeek(playbackProgressRef.current);
        }
      };
      const handleCancel = () => {
        endDrag();
        setPlaybackProgress(progressAtDragStartRef.current);
      };
      const listenerOptions = { signal: dragListeners.signal };
      window.addEventListener("pointermove", handleMove, listenerOptions);
      window.addEventListener("pointerup", handleUp, {
        ...listenerOptions,
        once: true,
      });
      window.addEventListener("pointercancel", handleCancel, {
        ...listenerOptions,
        once: true,
      });
      pointerCleanupRef.current = endDrag;
    },
    [disabled, getProgressFromClientX, previewSeek, commitSeek],
  );
  return (
    <Box
      {...warmup}
      aria-busy={isLoading}
      sx={{
        display: "flex",
        alignItems: "center",
        borderRadius: 999,
        border: (theme) => `1px solid ${theme.palette.divider}`,
        backgroundColor: (theme) => theme.vars?.palette.level1,
        px: 1,
        py: 0.25,
        gap: 1,
        width: "100%",
        maxWidth: 350,
        alignSelf: "flex-start",
      }}
    >
      <AudioPlaybackButton
        isPlaying={isPlaying}
        isLoading={isLoading}
        disabled={disabled}
        onClick={handlePlaybackToggle}
      />
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          minWidth: 42,
          fontFeatureSettings: '"tnum"',
        }}
      >
        {durationLabel}
      </Typography>
      <Box
        ref={waveformContainerRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressPercent)}
        aria-disabled={disabled || undefined}
        aria-label={intl.formatMessage({ defaultMessage: "Playback position" })}
        onPointerDown={handlePointerDown}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === " ") {
            event.preventDefault();
            void handlePlaybackToggle();
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            commitSeek(Math.min(1, playbackProgressRef.current + 0.05));
          } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            commitSeek(Math.max(0, playbackProgressRef.current - 0.05));
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            commitSeek(event.key === "Home" ? 0 : 1);
          }
        }}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: `${WAVEFORM_BAR_GAP}px`,
          flex: 1,
          height: 22,
          mx: 0.5,
          position: "relative",
          overflow: "hidden",
          cursor: "pointer",
          touchAction: "none",
          userSelect: "none",
          borderRadius: 0.5,
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 2,
          },
        }}
      >
        <AudioWaveformBars
          values={waveformBars}
          barWidth={computedBarWidth}
          progressPercent={progressPercent}
        />
      </Box>
      {actions}
    </Box>
  );
};
