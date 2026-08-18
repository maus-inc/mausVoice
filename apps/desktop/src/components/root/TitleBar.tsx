import { Box, IconButton, Stack, useColorScheme } from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { surfaceAlpha, surfaces } from "../../styles/palette";
import { hairline, titleBarShadow } from "../../styles/shadows";
import { isTauriRuntime } from "../../utils/env.utils";
import { LogoWithText } from "../common/LogoWithText";
import { MorphNavIcon } from "../common/MorphNavIcon";
import { ThemeModeToggle } from "./ThemeModeToggle";
import { WindowResizeHandles } from "./WindowResizeHandles";

/** Window-control glyphs are 16px so they stay optically level with the 18px
 * theme toggle without crowding the 28px button. */
const CONTROL_ICON_SIZE = 16;

/**
 * Custom frameless chrome title bar.
 * Drag region + native window controls with premium press feedback.
 */
export const TitleBar = () => {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const dark = resolved === "dark";
  const intl = useIntl();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
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
    if (!isTauriRuntime()) return;
    await getCurrentWindow().minimize();
  }, []);

  const toggleMax = useCallback(async () => {
    if (!isTauriRuntime()) return;
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

  // `Square` -> `Copy` (two offset squares) is the conventional
  // maximise/restore pair; MorphNavIcon tweens between the two paths.
  const maximizeIcon = useMemo(() => (maximized ? Copy : Square), [maximized]);

  const close = useCallback(async () => {
    if (!isTauriRuntime()) return;
    await getCurrentWindow().close();
  }, []);

  return (
    <>
      <WindowResizeHandles />
      <Box
        sx={{
          height: 40,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          px: 1,
          position: "relative",
          zIndex: 20,
          backgroundColor: dark
            ? surfaceAlpha(surfaces.dark.level1, 0.92)
            : surfaceAlpha(surfaces.light.level1, 0.88),
          backdropFilter: "blur(18px) saturate(1.2)",
          WebkitBackdropFilter: "blur(18px) saturate(1.2)",
          borderBottom: dark ? hairline.dark(0.05) : hairline.light(0.06),
          boxShadow: dark ? titleBarShadow.dark : titleBarShadow.light,
        }}
      >
        {/*
          Full-bleed drag region. Double-click to maximise is handled explicitly:
          with `decorations: false` the webview does not reliably synthesise the
          native double-click-to-maximise behaviour for a drag region.
        */}
        <Box
          data-tauri-drag-region
          onDoubleClick={() => void toggleMax()}
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
          }}
        />

        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            position: "relative",
            zIndex: 1,
            pl: 0.5,
            color: "text.primary",
          }}
        >
          <ThemeModeToggle />
          <LogoWithText />
        </Stack>

        <Box
          sx={{ flex: 1 }}
          data-tauri-drag-region
          onDoubleClick={() => void toggleMax()}
        />

        <Stack
          direction="row"
          spacing={0.25}
          sx={{
            alignItems: "center",
            position: "relative",
            zIndex: 1,
          }}
        >
          <IconButton
            size="small"
            onClick={() => void minimize()}
            aria-label={intl.formatMessage({ defaultMessage: "Minimize" })}
            sx={controlSx}
          >
            <MorphNavIcon icon={Minus} size={CONTROL_ICON_SIZE} />
          </IconButton>
          <IconButton
            size="small"
            onClick={() => void toggleMax()}
            aria-label={
              maximized
                ? intl.formatMessage({ defaultMessage: "Restore" })
                : intl.formatMessage({ defaultMessage: "Maximize" })
            }
            sx={controlSx}
          >
            <MorphNavIcon icon={maximizeIcon} size={CONTROL_ICON_SIZE} />
          </IconButton>
          <IconButton
            size="small"
            onClick={() => void close()}
            aria-label={intl.formatMessage({ defaultMessage: "Close" })}
            sx={{
              ...controlSx,
              "&:hover": {
                backgroundColor: "dangerHover",
                color: "error.contrastText",
              },
            }}
          >
            <MorphNavIcon icon={X} size={CONTROL_ICON_SIZE} />
          </IconButton>
        </Stack>
      </Box>
    </>
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
