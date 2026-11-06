import { Box, CircularProgress, IconButton, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { useIntentWarmup } from "../../hooks/intent-warmup.hooks";
import { transcriptionAudioCache } from "../../utils/transcription-audio-cache";
import { subscribeToLocalDataClearRequested } from "../../utils/local-data-write-gate";
import { springPop } from "../../styles/motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { MetalChrome } from "../common/MetalChrome";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTranscriptionRepo } from "../../repos";
import {
  cancelAudioPlaybackRequest,
  createAudioPlaybackRequest,
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
  const reduceMotion = useReducedMotion();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const isPlayingRef = useRef(false);
  const playbackProgressRef = useRef(0);
  const isDraggingRef = useRef(false);
  const progressAtDragStartRef = useRef(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackProgressRef.current = playbackProgress;
  }, [playbackProgress]);

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
    mountedRef.current = true;
    setIsPlaying(false);
    setIsLoading(false);
    setPlaybackProgress(0);
    const cancel = () => {
      if (requestRef.current) cancelAudioPlaybackRequest(requestRef.current);
      requestRef.current = null;
    };
    const unsubscribe = subscribeToLocalDataClearRequested(cancel);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      cancel();
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
    };
  }, [transcriptionId, disabled]);

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
    if (disabled) return;
    if (requestRef.current && !requestRef.current.signal.aborted) {
      cancelAudioPlaybackRequest(requestRef.current);
      requestRef.current = null;
      return;
    }
    const request = createAudioPlaybackRequest();
    requestRef.current = request;
    const current = () =>
      mountedRef.current &&
      requestRef.current === request &&
      !request.signal.aborted;
    let preparing = true;
    let stoppedDuringPreparation = false;
    const reset = () => {
      if (!mountedRef.current || requestRef.current !== request) return;
      setIsLoading(false);
      setIsPlaying(false);
      isPlayingRef.current = false;
      requestRef.current = null;
      cancelAudioPlaybackRequest(request);
    };
    request.signal.addEventListener("abort", reset, { once: true });
    setIsLoading(true);
    try {
      const audioData =
        await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
      if (!current()) return;
      await playWebAudio(
        transcriptionId,
        audioData,
        (progress) => {
          if (current() && !isDraggingRef.current)
            setPlaybackProgress(progress);
        },
        (reason) => {
          if (!current()) return;
          // Teardown can notify stop before preparation rejects. Keep its error owner.
          if (preparing) stoppedDuringPreparation = true;
          else reset();
          if (reason === "ended") setPlaybackProgress(0);
        },
        playbackProgressRef.current,
        request.signal,
      );
      preparing = false;
      if (current()) {
        if (stoppedDuringPreparation) {
          reset();
          return;
        }
        setIsLoading(false);
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
    } catch (error) {
      if (!current()) return;
      reset();
      setPlaybackProgress(0);
      console.error("Failed to toggle audio playback", error);
      showErrorSnackbar(
        intl.formatMessage({ defaultMessage: "Unable to play audio snippet." }),
      );
    }
  }, [transcriptionId, intl, disabled]);

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
    setPlaybackProgress(ratio);
  }, []);

  const commitSeek = useCallback((ratio: number) => {
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
      pointerCleanupRef.current?.();
      isDraggingRef.current = true;
      progressAtDragStartRef.current = playbackProgressRef.current;
      const next = getProgressFromClientX(event.clientX);
      if (next != null) previewSeek(next);

      const handleMove = (moveEvent: PointerEvent) => {
        const ratio = getProgressFromClientX(moveEvent.clientX);
        if (ratio != null) previewSeek(ratio);
      };
      // Every exit path (release, cancel, re-entrant drag, lifecycle cleanup)
      // runs this one teardown so `isDraggingRef` can never outlive its listeners.
      const endDrag = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        pointerCleanupRef.current = null;
        isDraggingRef.current = false;
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
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
      window.addEventListener("pointercancel", handleCancel, { once: true });
      pointerCleanupRef.current = endDrag;
    },
    [disabled, getProgressFromClientX, previewSeek, commitSeek],
  );

  return (
    <Box
      {...warmup}
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
      <MetalChrome variant="circle">
        <IconButton
          aria-label={
            isLoading
              ? intl.formatMessage({ defaultMessage: "Cancel audio loading" })
              : isPlaying
                ? intl.formatMessage({ defaultMessage: "Pause audio" })
                : intl.formatMessage({ defaultMessage: "Play audio" })
          }
          aria-busy={isLoading}
          size="small"
          onClick={handlePlaybackToggle}
          disabled={disabled}
          sx={{ p: 0.5 }}
        >
          {isLoading ? (
            <CircularProgress size="1rem" color="inherit" />
          ) : (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={isPlaying ? "pause" : "play"}
                initial={
                  reduceMotion
                    ? false
                    : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
                }
                animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                exit={
                  reduceMotion
                    ? undefined
                    : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
                }
                transition={springPop}
                style={{ display: "inline-flex" }}
              >
                {isPlaying ? (
                  <Pause size={16} strokeWidth={1.9} />
                ) : (
                  <Play size={16} strokeWidth={1.9} />
                )}
              </motion.span>
            </AnimatePresence>
          )}
        </IconButton>
      </MetalChrome>
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
        aria-label={intl.formatMessage({ defaultMessage: "Playback position" })}
        onPointerDown={handlePointerDown}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === " ") {
            event.preventDefault();
            void handlePlaybackToggle();
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            commitSeek(Math.min(1, playbackProgressRef.current + 0.05));
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            commitSeek(Math.max(0, playbackProgressRef.current - 0.05));
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
        }}
      >
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
          <Box
            sx={(theme) => ({
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              backgroundColor:
                theme.vars?.palette.level1 ?? theme.palette.background.paper,
              opacity: 0.5,
              transform: `translateX(${progressPercent}%)`,
              transition: "transform 140ms linear",
            })}
          />
        </Box>
        {waveformBars.map((value, index) => (
          <Box
            key={`wave-bar-${index}`}
            sx={(theme) => ({
              flex: "0 0 auto",
              width: `${computedBarWidth}px`,
              borderRadius: theme.spacing(0.25),
              backgroundColor: theme.vars?.palette.primary.main,
              height: `${Math.round(35 + value * 55)}%`,
              transition: "opacity 140ms ease",
            })}
          />
        ))}
      </Box>
      {actions}
    </Box>
  );
};
