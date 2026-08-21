import { Box, IconButton, Typography } from "@mui/material";
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTranscriptionRepo } from "../../repos";
import {
  activePlayback,
  buildWaveformOutline,
  DEFAULT_WAVEFORM_BAR_COUNT,
  formatDuration,
  MAX_COMPUTED_BAR_COUNT,
  MIN_COMPUTED_BAR_COUNT,
  MIN_WAVEFORM_BAR_VALUE,
  playWebAudio,
  seekPlayback,
  stopActivePlayback,
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
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const playbackNonceRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playbackProgressRef = useRef(0);
  const transcriptionIdRef = useRef(transcriptionId);
  const isDraggingRef = useRef(false);
  const progressAtDragStartRef = useRef(0);

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
      if (activePlayback?.transcriptionId === transcriptionIdRef.current) {
        stopActivePlayback("stopped");
      }
    };
  }, []);

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
    const currentNonce = playbackNonceRef.current + 1;
    playbackNonceRef.current = currentNonce;

    try {
      if (isPlayingRef.current) {
        stopActivePlayback("stopped");
        return;
      }

      const audioData =
        await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);

      if (playbackNonceRef.current !== currentNonce) {
        return;
      }

      setIsPlaying(true);
      await playWebAudio(
        transcriptionId,
        audioData,
        (progress) => {
          if (
            transcriptionIdRef.current === transcriptionId &&
            !isDraggingRef.current
          ) {
            setPlaybackProgress(progress);
          }
        },
        (reason) => {
          if (transcriptionIdRef.current !== transcriptionId) {
            return;
          }
          setIsPlaying(false);
          if (reason === "ended") {
            setPlaybackProgress(0);
          }
        },
        playbackProgressRef.current,
      );
    } catch (error) {
      console.error("Failed to toggle audio playback", error);
      setIsPlaying(false);
      setPlaybackProgress(0);
      showErrorSnackbar(
        intl.formatMessage({ defaultMessage: "Unable to play audio snippet." }),
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
      isDraggingRef.current = true;
      progressAtDragStartRef.current = playbackProgressRef.current;
      const next = getProgressFromClientX(event.clientX);
      if (next != null) previewSeek(next);

      const handleMove = (moveEvent: PointerEvent) => {
        const ratio = getProgressFromClientX(moveEvent.clientX);
        if (ratio != null) previewSeek(ratio);
      };
      const handleUp = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        pointerCleanupRef.current = null;
        isDraggingRef.current = false;
        const ratio = getProgressFromClientX(upEvent.clientX);
        if (ratio != null) {
          commitSeek(ratio);
        } else {
          commitSeek(playbackProgressRef.current);
        }
      };
      const handleCancel = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        pointerCleanupRef.current = null;
        isDraggingRef.current = false;
        setPlaybackProgress(progressAtDragStartRef.current);
      };
      pointerCleanupRef.current?.();
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
      window.addEventListener("pointercancel", handleCancel, { once: true });
      pointerCleanupRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
      };
    },
    [disabled, getProgressFromClientX, previewSeek, commitSeek],
  );

  return (
    <Box
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
      <IconButton
        aria-label={
          isPlaying
            ? intl.formatMessage({ defaultMessage: "Pause audio" })
            : intl.formatMessage({ defaultMessage: "Play audio" })
        }
        size="small"
        onClick={handlePlaybackToggle}
        disabled={disabled}
        sx={{ p: 0.5 }}
      >
        {isPlaying ? (
          <Pause size={16} strokeWidth={1.9} />
        ) : (
          <Play size={16} strokeWidth={1.9} />
        )}
      </IconButton>
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
