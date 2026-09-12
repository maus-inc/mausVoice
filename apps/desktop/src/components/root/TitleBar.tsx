import { Box, IconButton, Stack, useColorScheme } from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Plus, Square, X } from "lucide";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { surfaceAlpha, surfaces } from "../../styles/palette";
import { hairline, titleBarShadow } from "../../styles/shadows";
import { isTauriRuntime } from "../../utils/env.utils";
import { getPlatform } from "../../utils/platform.utils";
import { LogoWithText } from "../common/LogoWithText";
import { MorphNavIcon } from "../common/MorphNavIcon";
import { ThemeModeToggle } from "./ThemeModeToggle";
import { WindowResizeHandles } from "./WindowResizeHandles";

/** Window-control glyphs are 16px so they stay optically level with the 18px
 * theme toggle without crowding the button. */
const CONTROL_ICON_SIZE = 16;

const useMaximized = () => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let canceled = false;
    const win = getCurrentWindow();
    win
      .isMaximized()
      .then((value) => {
        if (!canceled) setMaximized(value);
      })
      .catch(() => undefined);
    win
      .onResized(async () => {
        try {
          const value = await win.isMaximized();
          if (!canceled) setMaximized(value);
        } catch {
          /* ignore */
        }
      })
      .then((fn) => {
        // `onResized` resolves asynchronously. If the effect cleaned up before
        // it resolved (e.g. React StrictMode double-invoke, or fast navigation),
        // the unlisten fn must be released immediately instead of being stored
        // and leaked, since the `return` below would have already run.
        if (canceled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
      unlisten?.();
    };
  }, []);

  return [maximized, setMaximized] as const;
};

const useWindowFocused = () => {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let canceled = false;
    const win = getCurrentWindow();
    if (typeof win.isFocused === "function") {
      win
        .isFocused()
        .then((value) => {
          if (!canceled) setFocused(value);
        })
        .catch(() => undefined);
    }
    const subscribe = (
      win as unknown as {
        onFocusChanged?: (
          handler: (event: { payload: boolean }) => void,
        ) => Promise<() => void>;
      }
    ).onFocusChanged;
    if (typeof subscribe === "function") {
      subscribe
        .call(win, ({ payload }) => {
          if (!canceled) setFocused(payload);
        })
        .then((fn) => {
          if (canceled) {
            fn();
          } else {
            unlisten = fn;
          }
        })
        .catch(() => undefined);
    }
    return () => {
      canceled = true;
      unlisten?.();
    };
  }, []);

  return focused;
};

const useWindowControls = (setMaximized: (value: boolean) => void) => {
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
  }, [setMaximized]);

  const close = useCallback(async () => {
    if (!isTauriRuntime()) return;
    await getCurrentWindow().close();
  }, []);

  return { minimize, toggleMax, close };
};

const captionButtonSx = {
  width: 46,
  height: 40,
  borderRadius: 0,
  color: "text.secondary",
  transition: "background-color 150ms ease, color 150ms ease",
  "&:hover": {
    backgroundColor: "action.hover",
    color: "text.primary",
  },
  "&:focus-visible": {
    outline: "2px solid",
    outlineColor: "primary.main",
    outlineOffset: -2,
  },
} as const;

/**
 * Custom frameless chrome title bar with per-platform control placement.
 * macOS gets left traffic lights; Windows and Linux keep right caption
 * buttons with full-height hover backplates. Glyphs are stable (no morphing,
 * no scale press) so small icons stay crisp.
 */
type TrafficLightProps = {
  focused: boolean;
  dark: boolean;
  closeLabel: string;
  minimizeLabel: string;
  maximizeLabel: string;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
};

const MacTrafficLights = ({
  focused,
  dark,
  closeLabel,
  minimizeLabel,
  maximizeLabel,
  onClose,
  onMinimize,
  onToggleMax,
}: TrafficLightProps) => (
  <Stack
    direction="row"
    spacing={1}
    sx={{
      alignItems: "center",
      position: "relative",
      zIndex: 1,
      opacity: focused ? 1 : 0.55,
    }}
  >
    <TrafficButton
      label={closeLabel}
      color={focused ? "#FF5F57" : "#8E8E93"}
      dark={dark}
      onClick={onClose}
      glyph={<MorphNavIcon icon={X} size={8} strokeWidth={2.5} />}
    />
    <TrafficButton
      label={minimizeLabel}
      color={focused ? "#FEBC2E" : "#8E8E93"}
      dark={dark}
      onClick={onMinimize}
      glyph={<MorphNavIcon icon={Minus} size={8} strokeWidth={2.5} />}
    />
    <TrafficButton
      label={maximizeLabel}
      color={focused ? "#28C840" : "#8E8E93"}
      dark={dark}
      onClick={onToggleMax}
      glyph={<MorphNavIcon icon={Plus} size={8} strokeWidth={2.5} />}
    />
  </Stack>
);

type CaptionButtonProps = {
  focused: boolean;
  minimizeLabel: string;
  maximizeLabel: string;
  closeLabel: string;
  maximized: boolean;
  onMinimize: () => void;
  onToggleMax: () => void;
  onClose: () => void;
};

const CaptionButtons = ({
  focused,
  minimizeLabel,
  maximizeLabel,
  closeLabel,
  maximized,
  onMinimize,
  onToggleMax,
  onClose,
}: CaptionButtonProps) => (
  <Stack
    direction="row"
    spacing={0}
    sx={{
      alignItems: "stretch",
      alignSelf: "stretch",
      position: "relative",
      zIndex: 1,
      opacity: focused ? 1 : 0.6,
    }}
  >
    <IconButton
      size="small"
      onClick={onMinimize}
      aria-label={minimizeLabel}
      sx={captionButtonSx}
    >
      <MorphNavIcon icon={Minus} size={CONTROL_ICON_SIZE} />
    </IconButton>
    <IconButton
      size="small"
      onClick={onToggleMax}
      aria-label={maximizeLabel}
      sx={captionButtonSx}
    >
      {maximized ? (
        <MorphNavIcon icon={Copy} size={CONTROL_ICON_SIZE} />
      ) : (
        <MorphNavIcon icon={Square} size={CONTROL_ICON_SIZE} />
      )}
    </IconButton>
    <IconButton
      size="small"
      onClick={onClose}
      aria-label={closeLabel}
      sx={{
        ...captionButtonSx,
        "&:hover": {
          backgroundColor: "rgba(232, 77, 77, 0.92)",
          color: "#fff",
        },
      }}
    >
      <MorphNavIcon icon={X} size={CONTROL_ICON_SIZE} />
    </IconButton>
  </Stack>
);
export const TitleBar = () => {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const dark = resolved === "dark";
  const intl = useIntl();
  const platform = getPlatform();
  const isMac = platform === "macos";
  const [maximized, setMaximized] = useMaximized();
  const focused = useWindowFocused();
  const { minimize, toggleMax, close } = useWindowControls(setMaximized);

  const minimizeLabel = intl.formatMessage({ defaultMessage: "Minimize" });
  const maximizeLabel = maximized
    ? intl.formatMessage({ defaultMessage: "Restore" })
    : intl.formatMessage({ defaultMessage: "Maximize" });
  const closeLabel = intl.formatMessage({ defaultMessage: "Close" });

  return (
    <>
      <WindowResizeHandles />
      <Box
        data-focused={focused}
        sx={{
          height: 40,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          px: isMac ? 1.5 : 0,
          pl: isMac ? 1.5 : 1,
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
          onDoubleClick={toggleMax}
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
          }}
        />

        {isMac ? (
          <MacTrafficLights
            focused={focused}
            dark={dark}
            closeLabel={closeLabel}
            minimizeLabel={minimizeLabel}
            maximizeLabel={maximizeLabel}
            onClose={close}
            onMinimize={minimize}
            onToggleMax={toggleMax}
          />
        ) : null}

        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            position: "relative",
            zIndex: 1,
            pl: isMac ? 1 : 0.5,
            color: "text.primary",
            opacity: focused ? 1 : 0.6,
          }}
        >
          <ThemeModeToggle />
          <LogoWithText />
        </Stack>

        <Box
          sx={{ flex: 1 }}
          data-tauri-drag-region
          onDoubleClick={toggleMax}
        />

        {isMac ? null : (
          <CaptionButtons
            focused={focused}
            minimizeLabel={minimizeLabel}
            maximizeLabel={maximizeLabel}
            closeLabel={closeLabel}
            maximized={maximized}
            onMinimize={minimize}
            onToggleMax={toggleMax}
            onClose={close}
          />
        )}
      </Box>
    </>
  );
};

const TrafficButton = ({
  label,
  color,
  dark,
  onClick,
  glyph,
}: {
  label: string;
  color: string;
  dark: boolean;
  onClick: () => void;
  glyph: React.ReactNode;
}) => (
  <Box
    component="button"
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="traffic-btn"
    sx={{
      width: 12,
      height: 12,
      borderRadius: "50%",
      border: "none",
      padding: 0,
      cursor: "default",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: color,
      color: dark ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.55)",
      transition: "filter 120ms ease",
      "&:hover": {
        filter: "brightness(1.08)",
      },
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: "primary.main",
        outlineOffset: 2,
      },
      "& .traffic-glyph": {
        opacity: 0,
        display: "flex",
      },
      "&:hover .traffic-glyph": {
        opacity: 0.85,
      },
    }}
  >
    <span className="traffic-glyph">{glyph}</span>
  </Box>
);
