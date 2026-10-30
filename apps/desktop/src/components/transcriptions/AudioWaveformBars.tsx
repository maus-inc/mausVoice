import { Box } from "@mui/material";

type AudioWaveformBarsProps = {
  values: number[];
  barWidth: number;
  progressPercent: number;
};

/** Decorative waveform and progress overlay; the parent owns slider semantics. */
export const AudioWaveformBars = ({
  values,
  barWidth,
  progressPercent,
}: AudioWaveformBarsProps) => (
  <>
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
    {values.map((value, index) => (
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
  </>
);
