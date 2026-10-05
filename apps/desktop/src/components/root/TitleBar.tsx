import { Box, IconButton, Stack } from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { IconNode } from "lucide";
import { Minus, Plus, X } from "lucide";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { useIsDarkMode } from "../../hooks/color-scheme.hooks";
import {
  captionButtonActive,
  captionButtonGlyph,
  captionButtonHover,
  captionButtonRestOpacity,
  chromeWash,
} from "../../styles/palette";
import { hairline, titleBarShadow } from "../../styles/shadows";
import { isTauriRuntime } from "../../utils/env.utils";
import { getPlatform } from "../../utils/platform.utils";
import { LogoWithText } from "../common/LogoWithText";
import { MorphNavIcon } from "../common/MorphNavIcon";
import { ThemeModeToggle } from "./ThemeModeToggle";
import {
  CAPTION_BUTTON_RADIUS,
  CAPTION_CLUSTER_GAP,
  CAPTION_CLUSTER_PAD_RIGHT,
  captionButtonSize,
  hasRightCaptionButtons,
  isCompactWidth,
  TITLE_BAR_HEIGHT,
  TRAFFIC_DOT_SIZE,
  TRAFFIC_HIT_SIZE,
} from "./titleBarGeometry";
import { WindowResizeHandles } from "./WindowResizeHandles";

/** Window-control glyphs are 16px so they stay optically level with the 18px
 * theme toggle without crowding the button. */
const CONTROL_ICON_SIZE = 16;

/**
 * The maximize glyph: a wide rounded rectangle rather than a square, and the
 * same glyph in both window states.
 *
 * The Windows maximize button is a single outline. Swapping to an overlapping
 * "restore" pair once the window is maximized reads as a different control
 * mid-gesture, and the pair needs more width than the box it stands for, so it
 * sits visibly off-centre in a square button.
 */
const MAXIMIZE_GLYPH: IconNode = [
  ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }],
];

/**
 * One `onResized` subscription carrying both the maximized flag and the bar
 * density.
 *
 * These used to be two hooks each registering `win.onResized`, so every tick of
 * a resize drag issued three IPC calls for two pieces of state that change in
 * the same event. Sharing the listener also means sharing the sequence guard,
 * which is what keeps a slow earlier tick from overwriting a newer reading --
 * the responses to a burst of resize events are unordered, so "last write wins"
 * is not the same as "newest measurement wins".
 *
 * Returns the maximized flag and whether the bar should render compact.
 */
const useWindowMetrics = () => {
  const [maximized, setMaximized] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let canceled = false;
    const win = getCurrentWindow();
    // Monotonic ticket per measurement. A response is applied only if no newer
    // measurement has started since, so a late reply for an older size is
    // dropped rather than reverting the bar to a density the window has left.
    let ticket = 0;

    const read = async () => {
      const current = ++ticket;
      const settled = () => !canceled && current === ticket;
      try {
        const [size, maximizedNow, scale] = await Promise.all([
          win.outerSize(),
          win.isMaximized(),
          win.scaleFactor(),
        ]);
        if (!settled()) return;
        // `outerSize()` reports physical device pixels, but every length in the
        // bar is a logical CSS pixel. Comparing the two directly would make the
        // threshold fire late on a scaled display: at 200% scaling a 1000px
        // window measures 2000, so a 900px threshold would never trigger.
        setCompact(isCompactWidth(size.width / (scale || 1)));
        setMaximized(maximizedNow);
      } catch {
        /* the window went away mid-measurement; the next tick re-reads */
      }
    };
    void read();

    win
      .onResized(read)
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

  // Storing the decision rather than the raw width means a resize drag
  // re-renders the bar only when the density actually changes, not on every
  // tick. An unknown window size reads as not compact, so browser preview keeps
  // the roomy default it has always shown.
  //
  // The setter is handed back so a caption-button click can update the flag
  // optimistically, without the bar waiting for the next resize event to
  // confirm what the window just did.
  return [maximized, setMaximized, compact] as const;
};

const useWindowFocused = () => {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let canceled = false;
    const win = getCurrentWindow();
    let receivedFocusEvent = false;
    win
      .isFocused()
      .then((value) => {
        // The initial snapshot can arrive after a newer native event.
        if (!canceled && !receivedFocusEvent) setFocused(value);
      })
      .catch(() => undefined);
    win
      .onFocusChanged(({ payload }) => {
        receivedFocusEvent = true;
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
    return () => {
      canceled = true;
      unlisten?.();
    };
  }, []);

  return focused;
};

type WindowControlHandler = () => void | Promise<void>;

const runWindowControl = async (
  operation: () => Promise<void>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    showErrorSnackbar(error);
  }
};

const useWindowControls = (setMaximized: (value: boolean) => void) => {
  const minimize = useCallback(
    () =>
      runWindowControl(async () => {
        if (!isTauriRuntime()) return;
        await getCurrentWindow().minimize();
      }),
    [],
  );

  const toggleMax = useCallback(
    () =>
      runWindowControl(async () => {
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
      }),
    [setMaximized],
  );

  const close = useCallback(
    () =>
      runWindowControl(async () => {
        if (!isTauriRuntime()) return;
        await getCurrentWindow().close();
      }),
    [],
  );

  return { minimize, toggleMax, close };
};

/**
 * The window-control buttons, sized and coloured off one factory.
 *
 * Square targets inset from the bar edges rather than flush strips, so the
 * bar's own material is visible between them and against the window edge. That
 * is what separates a control cluster from a row of divider lines.
 */
const captionButtonFill = (dark: boolean, pressed: boolean): string => {
  const fills = pressed ? captionButtonActive : captionButtonHover;

  return dark ? fills.dark : fills.light;
};

const captionButtonSx = (dark: boolean, compact: boolean) => {
  const size = captionButtonSize(compact);

  return {
    width: size,
    height: size,
    // A string, not a number: MUI multiplies a numeric `borderRadius` by
    // `theme.shape.borderRadius`, which is 14 here, so `12` would paint 168px.
    borderRadius: `${CAPTION_BUTTON_RADIUS}px`,
    color: dark ? captionButtonGlyph.dark : captionButtonGlyph.light,
    opacity: captionButtonRestOpacity,
    // Windows corner smoothing cannot be set here: MUI's style system drops
    // properties it does not recognise, so it lives on `.caption-button` in
    // `styles/tokens.css` instead. The transition reads the shared duration
    // token rather than a literal because the token collapses to 1ms under
    // prefers-reduced-motion, and a hand-written value would ignore that.
    transition:
      "background-color var(--duration-fast) ease, color var(--duration-fast) ease, opacity var(--duration-fast) ease, transform var(--duration-fast) ease",
    "&:hover": {
      backgroundColor: captionButtonFill(dark, false),
      opacity: 1,
    },
    "&:active": {
      backgroundColor: captionButtonFill(dark, true),
      opacity: 1,
      transform: "scale(0.95)",
    },
    "&:focus-visible": {
      outline: "2px solid",
      outlineColor: "primary.main",
      outlineOffset: -2,
    },
  } as const;
};

/**
 * A macOS-style traffic light.
 *
 * The painted dot stays at `TRAFFIC_DOT_SIZE` because that is the native
 * proportion, but the button itself is `TRAFFIC_HIT_SIZE` square so the target
 * meets the WCAG 2.2 minimum target size. A 12px target is close to
 * unacquirable on a trackpad, which is the "poor icon clarity on small
 * windows" complaint stated as a hit-area problem rather than a glyph problem.
 */
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
  onClick: WindowControlHandler;
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
      // The hit target, not the visible dot.
      width: TRAFFIC_HIT_SIZE,
      height: TRAFFIC_HIT_SIZE,
      borderRadius: "50%",
      border: "none",
      padding: 0,
      cursor: "default",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "transparent",
      // No hover backplate here. The dot already shows a hover treatment, and
      // painting one on the 24px box as well makes a single hover read as two
      // separate highlights. The dot reacting is also what macOS does.
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: "primary.main",
        outlineOffset: 2,
      },
    }}
  >
    <Box
      className="traffic-dot"
      sx={{
        width: TRAFFIC_DOT_SIZE,
        height: TRAFFIC_DOT_SIZE,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color,
        color: dark ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.55)",
        transition: "filter 120ms ease",
        // The hover rule lives on the button, not on the dot. The hit target is
        // six pixels larger on each side than the painted dot, so a `:hover`
        // scoped to the dot left the outer ring of a perfectly reachable target
        // dead.
        ".traffic-btn:hover &": {
          filter: "brightness(1.08)",
        },
        "& .traffic-glyph": {
          opacity: 0,
          display: "flex",
        },
        ".traffic-btn:hover & .traffic-glyph": {
          opacity: 0.85,
        },
      }}
    >
      <span className="traffic-glyph">{glyph}</span>
    </Box>
  </Box>
);

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
  onClose: WindowControlHandler;
  onMinimize: WindowControlHandler;
  onToggleMax: WindowControlHandler;
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
  dark: boolean;
  focused: boolean;
  compact: boolean;
  minimizeLabel: string;
  maximizeLabel: string;
  closeLabel: string;
  onMinimize: WindowControlHandler;
  onToggleMax: WindowControlHandler;
  onClose: WindowControlHandler;
};

const CaptionButtons = ({
  dark,
  focused,
  compact,
  minimizeLabel,
  maximizeLabel,
  closeLabel,
  onMinimize,
  onToggleMax,
  onClose,
}: CaptionButtonProps) => {
  const sx = captionButtonSx(dark, compact);
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: "center",
        alignSelf: "stretch",
        gap: `${CAPTION_CLUSTER_GAP}px`,
        pr: `${CAPTION_CLUSTER_PAD_RIGHT}px`,
        position: "relative",
        zIndex: 1,
        // Focus dimming rides the wrapper so the three dim as one group. The
        // per-button rest opacity lives in `captionButtonSx`, which also owns the
        // step back to full on hover and press.
        opacity: focused ? 1 : 0.6,
      }}
    >
      <IconButton
        size="small"
        onClick={onMinimize}
        aria-label={minimizeLabel}
        className="caption-button"
        sx={sx}
      >
        <MorphNavIcon icon={Minus} size={CONTROL_ICON_SIZE} strokeWidth={2} />
      </IconButton>
      <IconButton
        size="small"
        onClick={onToggleMax}
        aria-label={maximizeLabel}
        className="caption-button"
        sx={sx}
      >
        <MorphNavIcon
          icon={MAXIMIZE_GLYPH}
          size={CONTROL_ICON_SIZE}
          strokeWidth={2}
        />
      </IconButton>
      <IconButton
        size="small"
        onClick={onClose}
        aria-label={closeLabel}
        className="caption-button"
        sx={sx}
      >
        <MorphNavIcon icon={X} size={CONTROL_ICON_SIZE} strokeWidth={2} />
      </IconButton>
    </Stack>
  );
};
const titleBarSx = (dark: boolean, trafficLights: boolean) =>
  ({
    height: TITLE_BAR_HEIGHT,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    px: trafficLights ? 1.5 : 0,
    pl: trafficLights ? 1.5 : 1,
    // Caption buttons sit flush against the right window edge (like native
    // Windows chrome); the NorthEast resize grip overlaps the close button's
    // outer corner.
    pr: trafficLights ? 1.5 : 0,
    position: "relative",
    zIndex: 20,
    // Same wash as the navigation rail, so the bar and the rail read as one
    // material. They share that paint but are not contiguous: the page header
    // sits between them, and the content area carries none of it.
    background: dark ? chromeWash.dark : chromeWash.light,
    backdropFilter: "blur(18px) saturate(1.2)",
    WebkitBackdropFilter: "blur(18px) saturate(1.2)",
    borderBottom: dark ? hairline.dark(0.05) : hairline.light(0.06),
    boxShadow: dark ? titleBarShadow.dark : titleBarShadow.light,
  }) as const;

export const TitleBar = () => {
  const dark = useIsDarkMode();
  const intl = useIntl();
  const platform = isTauriRuntime() ? getPlatform() : "unknown";
  // Same predicate the resize grips use, so the chrome and the grips can never
  // disagree. Browser preview ("unknown") gets right-side caption buttons.
  const trafficLights = !hasRightCaptionButtons(platform);
  // Maximized flag and bar density come from one subscription: they change in
  // the same event, so reading them separately issued duplicated IPC on every
  // tick of a resize drag.
  const [maximized, setMaximized, compact] = useWindowMetrics();
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
      <Box data-focused={focused} sx={titleBarSx(dark, trafficLights)}>
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

        {trafficLights ? (
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
            pl: trafficLights ? 1 : 0.5,
            color: "text.primary",
            opacity: focused ? 1 : 0.6,
          }}
        >
          <ThemeModeToggle />
          <LogoWithText compact={compact} />
        </Stack>

        <Box
          sx={{ flex: 1 }}
          data-tauri-drag-region
          onDoubleClick={toggleMax}
        />

        {trafficLights ? null : (
          <CaptionButtons
            dark={dark}
            focused={focused}
            compact={compact}
            minimizeLabel={minimizeLabel}
            maximizeLabel={maximizeLabel}
            closeLabel={closeLabel}
            onMinimize={minimize}
            onToggleMax={toggleMax}
            onClose={close}
          />
        )}
      </Box>
    </>
  );
};
