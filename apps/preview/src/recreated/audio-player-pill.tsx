/**
 * AudioPlayerPill — recreated.
 *
 * Why recreated: the real component loads audio bytes from the transcription
 * repo and plays via WebAudio (repos/actions chain unavailable in preview).
 * Layout, styles, and waveform-bar math are copied verbatim from
 * components/transcriptions/AudioPlayerPill.tsx + utils/audio-playback.utils:
 *  radius 999 · 1px divider border · level1 · px1 py0.25 gap1 · maxWidth 350 ·
 *  IconButton p0.5 · body2 secondary tnum duration minWidth 42 ·
 *  bars: width clamp 2–4, gap 2, count 24–120 (default 58),
 *  height 35+value*55%, radius spacing 0.25, primary.main fill,
 *  progress veil level1 @ .5, left-transition 140ms linear.
 * Playback is a simulated clock; the deterministic outline comes from a
 * seeded PRNG keyed by transcriptionId (the real buildWaveformOutline is
 * content-derived — flagged in the spec file).
 */
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { Box, IconButton, Typography } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSpecValue } from "../lib/spec-store";

const DEFAULT_COUNT = 58;
const MIN_BAR = 0.05;
const MIN_COUNT = 24;
const MAX_COUNT = 120;
const BAR_MIN_W = 2;
const BAR_MAX_W = 4;
const BAR_GAP = 2;

export const formatDuration = (durationMs?: number | null): string => {
  if (!durationMs || !Number.isFinite(durationMs)) return "0:00";
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const seededOutline = (seed: string, count: number): number[] => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => MIN_BAR + rand() * (1 - MIN_BAR));
};

export const AudioPlayerPillPreview = ({
  transcriptionId = "demo-transcription",
  durationMs = 42000,
  disabled,
  actions,
  autoplay,
}: {
  transcriptionId?: string;
  durationMs?: number | null;
  disabled?: boolean;
  actions?: React.ReactNode;
  autoplay?: boolean;
}) => {
  const maxWidth = useSpecValue("audio-player-pill", "max-width", 350);
  const [isPlaying, setIsPlaying] = useState(!!autoplay);
  const [progress, setProgress] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWaveformWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [transcriptionId]);

  useEffect(() => {
    if (!isPlaying) return;
    const total = durationMs && durationMs > 0 ? durationMs : 30000;
    const started = performance.now() - progress * total;
    let raf = 0;
    const tick = (now: number) => {
      const p = (now - started) / total;
      if (p >= 1) {
        setProgress(0);
        setIsPlaying(false);
        return;
      }
      setProgress(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  const count = useMemo(() => {
    if (waveformWidth <= 0) return DEFAULT_COUNT;
    const approx = Math.floor((waveformWidth + BAR_GAP) / (BAR_MIN_W + BAR_GAP));
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, approx));
  }, [waveformWidth]);

  const bars = useMemo(
    () => seededOutline(transcriptionId, count),
    [transcriptionId, count],
  );

  const barWidth = useMemo(() => {
    if (waveformWidth <= 0 || bars.length === 0) return BAR_MIN_W;
    const gaps = BAR_GAP * Math.max(bars.length - 1, 0);
    const per = Math.max(waveformWidth - gaps, 0) / bars.length;
    return Math.max(BAR_MIN_W, Math.min(BAR_MAX_W, per));
  }, [bars.length, waveformWidth]);

  const progressPercent = Math.min(Math.max(progress, 0), 1) * 100;

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
        maxWidth,
        alignSelf: "flex-start",
      }}
    >
      <IconButton
        aria-label={isPlaying ? "Pause audio" : "Play audio"}
        size="small"
        onClick={() => !disabled && setIsPlaying((p) => !p)}
        disabled={disabled}
        sx={{ p: 0.5 }}
      >
        {isPlaying ? <PauseRoundedIcon fontSize="small" /> : <PlayArrowRoundedIcon fontSize="small" />}
      </IconButton>
      <Typography variant="body2" sx={{ color: "text.secondary", minWidth: 42, fontFeatureSettings: '"tnum"' }}>
        {formatDuration(durationMs)}
      </Typography>
      <Box
        ref={containerRef}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: `${BAR_GAP}px`,
          flex: 1,
          height: 22,
          mx: 0.5,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <Box sx={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <Box
            sx={(theme) => ({
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${progressPercent}%`,
              right: 0,
              backgroundColor: theme.vars?.palette.level1 ?? theme.palette.background.paper,
              opacity: 0.5,
              transition: "left 140ms linear",
            })}
          />
        </Box>
        {bars.map((value, index) => (
          <Box
            key={`wave-bar-${index}`}
            sx={(theme) => ({
              flex: "0 0 auto",
              width: `${barWidth}px`,
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
