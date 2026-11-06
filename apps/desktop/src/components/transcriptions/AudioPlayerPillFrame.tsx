import { Box } from "@mui/material";
import type { ReactNode } from "react";

/** Shared shell for the real audio player and its simulated preview. */
export const AudioPlayerPillFrame = ({
  children,
  maxWidth = 350,
}: {
  children: ReactNode;
  maxWidth?: number;
}) => (
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
    {children}
  </Box>
);
