import { listenForPointerDrag } from "./pointer-drag-listeners";
import { AudioPlayerPillFrame } from "./AudioPlayerPillFrame";
import { Box, IconButton, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { springPop } from "../../styles/motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useIntl, type IntlShape } from "react-intl";
import { MetalChrome } from "../common/MetalChrome";
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
  playWebAudioCancellable,
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

/** Track waveform density and width independently from playback ownership. */
const useWaveform = (
  transcriptionId: string,
  durationMs: number | null | undefined,
) => {
  const [waveformWidth, setWaveformWidth] = useState(0);
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
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

  return { waveformContainerRef, waveformBars, computedBarWidth };
};

/** Own one row's audio request, state, and cancellation across identity changes. */
const useAudioPlayback = (transcriptionId: string, intl: IntlShape) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const playbackNonceRef = useRef(0);
  const playbackAbortRef = useRef<AbortController | null>(null);
  const isPlayingRef = useRef(false);
  const playbackProgressRef = useRef(0);
  const transcriptionIdRef = useRef(transcriptionId);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackProgressRef.current = playbackProgress;
  }, [playbackProgress]);

  useEffect(() => {
    transcriptionIdRef.current = transcriptionId;
    setIsPlaying(false);
    setPlaybackProgress(0);
    return () => {
      // A late audio load belongs to this row identity, not its replacement.
      playbackNonceRef.current += 1;
      playbackAbortRef.current?.abort();
      playbackAbortRef.current = null;
      if (activePlayback?.transcriptionId === transcriptionId) {
        stopActivePlayback("stopped");
      }
    };
  }, [transcriptionId]);

  const handlePlaybackToggle = useCallback(async () => {
    const currentNonce = playbackNonceRef.current + 1;
    playbackNonceRef.current = currentNonce;
    playbackAbortRef.current?.abort();
    const controller = new AbortController();
    playbackAbortRef.current = controller;

    try {
      if (isPlayingRef.current) {
        stopActivePlayback("stopped");
        setIsPlaying(false);
        return;
      }

      const audioData =
        await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);

      if (playbackNonceRef.current !== currentNonce) {
        return;
      }

      setIsPlaying(true);
      await playWebAudioCancellable(
        transcriptionId,
        audioData,
        (progress) => {
          if (
            transcriptionIdRef.current === transcriptionId &&
            playbackNonceRef.current === currentNonce &&
            !isDraggingRef.current
          ) {
            setPlaybackProgress(progress);
          }
        },
        (reason) => {
          if (
            transcriptionIdRef.current !== transcriptionId ||
            playbackNonceRef.current !== currentNonce
          ) {
            return;
          }
          setIsPlaying(false);
          if (reason === "ended") {
            setPlaybackProgress(0);
          }
        },
        playbackProgressRef.current,
        controller.signal,
      );
    } catch {
      if (playbackNonceRef.current !== currentNonce) return;
      console.error("Failed to toggle audio playback");
      setIsPlaying(false);
      setPlaybackProgress(0);
      showErrorSnackbar(
        intl.formatMessage({ defaultMessage: "Unable to play audio snippet." }),
      );
    } finally {
      if (playbackAbortRef.current === controller)
        playbackAbortRef.current = null;
    }
  }, [transcriptionId, intl]);

  return {
    isPlaying,
    isPlayingRef,
    playbackProgress,
    playbackProgressRef,
    setPlaybackProgress,
    isDraggingRef,
    handlePlaybackToggle,
  };
};

/** Own pointer and keyboard seeking without letting a drag outlive its row. */
const useWaveformSeeking = ({
  transcriptionId,
  disabled,
  waveformContainerRef,
  isPlayingRef,
  playbackProgressRef,
  setPlaybackProgress,
  isDraggingRef,
}: {
  transcriptionId: string;
  disabled: boolean | undefined;
  waveformContainerRef: RefObject<HTMLDivElement | null>;
  isPlayingRef: RefObject<boolean>;
  playbackProgressRef: RefObject<number>;
  setPlaybackProgress: Dispatch<SetStateAction<number>>;
  isDraggingRef: RefObject<boolean>;
}) => {
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const progressAtDragStartRef = useRef(0);
  useEffect(() => {
    return () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      isDraggingRef.current = false;
    };
  }, [transcriptionId, isDraggingRef]);

  /** Scrub mapping from client X (same idea as elevenlabs-ui scrub-bar). Bars are a seeded silhouette, not live PCM. */
  const getProgressFromClientX = useCallback(
    (clientX: number) => {
      const track = waveformContainerRef.current;
      if (!track) return null;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const ratio = (clientX - rect.left) / rect.width;
      return Math.min(Math.max(ratio, 0), 1);
    },
    [waveformContainerRef],
  );

  const previewSeek = useCallback(
    (ratio: number) => {
      setPlaybackProgress(ratio);
    },
    [setPlaybackProgress],
  );

  const commitSeek = useCallback(
    (ratio: number) => {
      setPlaybackProgress(ratio);
      if (isPlayingRef.current) {
        seekPlayback(ratio);
      }
    },
    [setPlaybackProgress, isPlayingRef],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      isDraggingRef.current = true;
      progressAtDragStartRef.current = playbackProgressRef.current;
      const next = getProgressFromClientX(event.clientX);
      if (next != null) previewSeek(next);

      pointerCleanupRef.current?.();
      pointerCleanupRef.current = listenForPointerDrag(window, {
        move: (moveEvent) => {
          const ratio = getProgressFromClientX(moveEvent.clientX);
          if (ratio != null) previewSeek(ratio);
        },
        end: (upEvent) => {
          pointerCleanupRef.current = null;
          isDraggingRef.current = false;
          const ratio = getProgressFromClientX(upEvent.clientX);
          commitSeek(ratio ?? playbackProgressRef.current);
        },
        cancel: () => {
          pointerCleanupRef.current = null;
          isDraggingRef.current = false;
          setPlaybackProgress(progressAtDragStartRef.current);
        },
      });
    },
    [
      disabled,
      getProgressFromClientX,
      previewSeek,
      commitSeek,
      isDraggingRef,
      playbackProgressRef,
      setPlaybackProgress,
    ],
  );

  return { handlePointerDown, commitSeek };
};

export const AudioPlayerPill = ({
  transcriptionId,
  durationMs,
  disabled,
  actions,
}: AudioPlayerPillProps) => {
  const intl = useIntl();
  const reduceMotion = useReducedMotion();

  const { waveformContainerRef, waveformBars, computedBarWidth } = useWaveform(
    transcriptionId,
    durationMs,
  );
  const {
    isPlaying,
    isPlayingRef,
    playbackProgress,
    playbackProgressRef,
    setPlaybackProgress,
    isDraggingRef,
    handlePlaybackToggle,
  } = useAudioPlayback(transcriptionId, intl);

  const progressPercent = Math.min(Math.max(playbackProgress, 0), 1) * 100;

  const durationLabel = formatDuration(durationMs);

  const { handlePointerDown, commitSeek } = useWaveformSeeking({
    transcriptionId,
    disabled,
    waveformContainerRef,
    isPlayingRef,
    playbackProgressRef,
    setPlaybackProgress,
    isDraggingRef,
  });

  return (
    <AudioPlayerPillFrame>
      <MetalChrome variant="circle">
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
    </AudioPlayerPillFrame>
  );
};
