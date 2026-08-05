import {
  CloseRounded,
  CropSquareRounded,
  FilterNoneRounded,
  HorizontalRuleRounded,
} from "@mui/icons-material";
import { Box, IconButton, Stack, useColorScheme } from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { titleBarShadow } from "../../styles/shadows";
import { LogoWithText } from "../common/LogoWithText";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * Custom frameless chrome title bar.
 * Drag region + native window controls with premium press feedback.
 */
export const TitleBar = () => {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const dark = resolved === "dark";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
    win
      .onResized(async () => {
        try {
          setMaximized(await win.isMaximized());
        } catch {
          /* ignore */
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const minimize = useCallback(async () => {
    if (!isTauri()) return;
    await getCurrentWindow().minimize();
  }, []);

  const toggleMax = useCallback(async () => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const isMax = await win.isMaximized();
    if (isMax) {
      await win.unmaximize();
      setMaximized(false);
    } else {
      await win.maximize();
      setMaximized(true);
    }
  }, []);

  const close = useCallback(async () => {
    if (!isTauri()) return;
    await getCurrentWindow().close();
  }, []);

  return (
    <Box
      sx={{
        height: 44,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        px: 1.25,
        position: "relative",
        zIndex: 20,
        backgroundColor: dark
          ? "rgba(20,22,27,0.92)"
          : "rgba(255,255,255,0.88)",
        backdropFilter: "blur(18px) saturate(1.2)",
        WebkitBackdropFilter: "blur(18px) saturate(1.2)",
        borderBottom: dark
          ? "1px solid rgba(255,255,255,0.05)"
          : "1px solid rgba(15,18,25,0.06)",
        boxShadow: dark ? titleBarShadow.dark : titleBarShadow.light,
      }}
    >
      <Box
        data-tauri-drag-region
        sx={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
        }}
      />

      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ position: "relative", zIndex: 1, pl: 0.5 }}
      >
        <LogoWithText />
      </Stack>

      <Box sx={{ flex: 1 }} data-tauri-drag-region />

      <Stack
        direction="row"
        alignItems="center"
        spacing={0.25}
        sx={{ position: "relative", zIndex: 1 }}
      >
        <IconButton
          size="small"
          onClick={() => void minimize()}
          aria-label="Minimize"
          sx={controlSx}
        >
          <HorizontalRuleRounded sx={{ fontSize: 16 }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => void toggleMax()}
          aria-label={maximized ? "Restore" : "Maximize"}
          sx={controlSx}
        >
          {maximized ? (
            <FilterNoneRounded sx={{ fontSize: 14 }} />
          ) : (
            <CropSquareRounded sx={{ fontSize: 15 }} />
          )}
        </IconButton>
        <IconButton
          size="small"
          onClick={() => void close()}
          aria-label="Close"
          sx={{
            ...controlSx,
            "&:hover": {
              backgroundColor: "rgba(232, 77, 77, 0.92)",
              color: "#fff",
            },
          }}
        >
          <CloseRounded sx={{ fontSize: 16 }} />
        </IconButton>
      </Stack>
    </Box>
  );
};

const controlSx = {
  width: 34,
  height: 28,
  borderRadius: 1.5,
  color: "text.secondary",
  transition:
    "transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms cubic-bezier(0.23, 1, 0.32, 1), color 150ms cubic-bezier(0.23, 1, 0.32, 1)",
  "&:hover": {
    backgroundColor: "action.hover",
    color: "text.primary",
  },
  "&:active": {
    transform: "scale(0.94)",
  },
} as const;
