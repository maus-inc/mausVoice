/** Shared building blocks for component demos: state matrices, labeled
 *  cells, token swatches. All preview chrome uses the real desktop theme. */
import { Box, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export const DemoSection = ({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) => (
  <Box sx={{ mb: 4 }}>
    <Typography variant="titleSmall" sx={{ display: "block", mb: 0.5 }}>
      {title}
    </Typography>
    {hint && (
      <Typography variant="bodySmall" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
        {hint}
      </Typography>
    )}
    {children}
  </Box>
);

/** One labeled cell in a state matrix. */
export const State = ({
  label,
  children,
  wide,
  dark,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  dark?: boolean;
}) => (
  <Paper
    variant="flat"
    sx={{
      p: 2,
      minHeight: 96,
      display: "flex",
      flexDirection: "column",
      gap: 1.5,
      alignItems: "flex-start",
      justifyContent: "center",
      gridColumn: wide ? "1 / -1" : undefined,
      ...(dark
        ? { backgroundColor: "#000", border: "1px solid rgba(255,255,255,0.08)" }
        : {}),
    }}
  >
    <Box
      sx={{
        flex: 1,
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        flexWrap: "wrap",
        py: 1,
      }}
    >
      {children}
    </Box>
    <Typography variant="labelSmall" color="text.secondary">
      {label}
    </Typography>
  </Paper>
);

/** Responsive grid of <State> cells. */
export const Matrix = ({ children }: { children: ReactNode }) => (
  <Box
    sx={{
      display: "grid",
      gap: 2,
      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    }}
  >
    {children}
  </Box>
);

export const Row = ({ children }: { children: ReactNode }) => (
  <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap", alignItems: "center" }}>
    {children}
  </Stack>
);

export const Swatch = ({
  color,
  label,
  value,
  border,
}: {
  color: string;
  label: string;
  value: string;
  border?: boolean;
}) => (
  <Paper variant="flat" sx={{ p: 1.5, minWidth: 150, flex: "1 1 150px" }}>
    <Box
      sx={{
        height: 44,
        borderRadius: 1.5,
        backgroundColor: color,
        border: border ? "1px solid" : "none",
        borderColor: "divider",
        mb: 1,
      }}
    />
    <Typography variant="labelSmall" sx={{ display: "block" }}>
      {label}
    </Typography>
    <Typography variant="bodySmall" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: 11 }}>
      {value}
    </Typography>
  </Paper>
);

export const TokenRow = ({ token, value }: { token: string; value: string }) => (
  <Box
    sx={{
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 2,
      py: 0.75,
      borderBottom: "1px solid",
      borderColor: "divider",
      fontSize: 13,
    }}
  >
    <Typography variant="bodySmall" sx={{ fontFamily: "monospace" }}>
      {token}
    </Typography>
    <Typography variant="bodySmall" color="text.secondary" sx={{ fontFamily: "monospace", textAlign: "right" }}>
      {value}
    </Typography>
  </Box>
);

/** Interactive hint chip shown above live controls. */
export const TryIt = ({ children }: { children: ReactNode }) => (
  <Typography variant="bodySmall" color="text.secondary" sx={{ mb: 1 }}>
    Try it — {children}
  </Typography>
);
