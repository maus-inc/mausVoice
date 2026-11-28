import { Box, Typography } from "@mui/material";
import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { useIntentWarmup } from "../../hooks/intent-warmup.hooks";
import { getTranscriptionRepo } from "../../repos";
import {
  formatDuration,
  WAVEFORM_BAR_GAP,
} from "../../utils/audio-playback.utils";
import { transcriptionAudioCache } from "../../utils/transcription-audio-cache";
import { AudioPlaybackButton } from "./AudioPlaybackButton";
import { AudioWaveformBars } from "./AudioWaveformBars";
import { useWaveformLayout } from "./audio-pill-geometry";
import {
  commitSeek,
  getScrubSeekForKey,
  useAudioPillDrag,
} from "./audio-pill-scrub";
import { useAudioPillPlayback } from "./use-audio-pill-playback";

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
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);

  const playback = useAudioPillPlayback({ transcriptionId, disabled, intl });
  const { handlePointerDown } = useAudioPillDrag({
    transcriptionId,
    disabled,
    containerRef: waveformContainerRef,
    playback,
  });
  const waveform = useWaveformLayout({
    transcriptionId,
    durationMs,
    containerRef: waveformContainerRef,
  });

  // Hovering the pill warms the saved audio through the repository cache so
  // the first click starts from a warm read (the cache is TTL-bounded and
  // throttled; see transcription-audio-cache.ts).
  const warmAudio = useCallback(async () => {
    if (!disabled && transcriptionAudioCache.canWarm()) {
      await getTranscriptionRepo().loadTranscriptionAudio(transcriptionId);
    }
  }, [disabled, transcriptionId]);
  const warmup = useIntentWarmup(warmAudio, transcriptionId);

  const progressPercent =
    Math.min(Math.max(playback.playbackProgress, 0), 1) * 100;

  const handleScrubKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === " ") {
      event.preventDefault();
      void playback.togglePlayback();
      return;
    }
    const seek = getScrubSeekForKey(event.key, playback.progressRef.current);
    if (seek === null) return;
    event.preventDefault();
    commitSeek(seek, playback);
  };

  return (
    <Box
      {...warmup}
      aria-busy={playback.isLoading}
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
        isPlaying={playback.isPlaying}
        isLoading={playback.isLoading}
        disabled={disabled}
        onClick={playback.togglePlayback}
      />
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          minWidth: 42,
          fontFeatureSettings: '"tnum"',
        }}
      >
        {formatDuration(durationMs)}
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
        onKeyDown={handleScrubKeyDown}
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
          values={waveform.bars}
          barWidth={waveform.barWidth}
          progressPercent={progressPercent}
        />
      </Box>
      {actions}
    </Box>
  );
};
