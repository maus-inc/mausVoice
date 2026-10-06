import { Box, IconButton, Stack } from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { IconNode } from "lucide";
import { Minus, Plus, X } from "lucide";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Minimum pointer travel in CSS pixels before a primary-button press on the
 * title bar hands off to `win.startDragging()`.
 *
 * Tauri's injected `drag.js` invokes `plugin:window|start_dragging` on the very
 * first `mousedown` (`detail === 1`) before the pointer has moved. On
 * undecorated windows (`decorations: false`) that immediate OS move loop
 * (1) unmaximizes a maximized window while leaving it at full-screen width
 * (tauri#11945), (2) swallows the first `mouseup` on Windows/Linux so the
 * browser never synthesizes `dblclick` (tauri#10767), and (3) on `detail === 2`
 * invokes `internal_toggle_maximize` right before `onDoubleClick` fires
 * `toggleMax`, toggling maximize twice and canceling out.
 */
const DRAG_START_DISTANCE_PX = 4;

type WindowSize = { width: number; height: number };

type DragPoint = { x: number; y: number };

const hasPositiveDimensions = (size: WindowSize | undefined): boolean => {
  if (size === undefined) return true;
  return size.width > 0 && size.height > 0;
};

const readWindowSize = (
  win: ReturnType<typeof getCurrentWindow>,
): Promise<WindowSize> =>
  typeof win.innerSize === "function" ? win.innerSize() : win.outerSize();

const readWindowMinimized = (
  win: ReturnType<typeof getCurrentWindow>,
): Promise<boolean> =>
  typeof win.isMinimized === "function"
    ? win.isMinimized()
    : Promise.resolve(false);

const isActiveTicket = (
  canceled: boolean,
  current: number,
  latest: number,
): boolean => !canceled && current === latest;

const shouldApplySize = (minimized: boolean, size: WindowSize): boolean =>
  !minimized && hasPositiveDimensions(size);

const toLogicalWidth = (physicalWidth: number, scale: number): number =>
  physicalWidth / (scale || 1);

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
 * Returns the maximized flag, an optimistic setter, the synchronous maximized
 * ref, and whether the bar should render compact.
 */
const useWindowMetrics = () => {
  const [maximized, setMaximized] = useState(false);
  const [compact, setCompact] = useState(false);
  // Separate monotonic tickets for width vs. maximized state so an optimistic
  // maximize toggle guards `setMaximized` against stale pre-click measurements
  // without discarding the latest width measurement for `setCompact`.
  const sizeTicketRef = useRef(0);
  const maxTicketRef = useRef(0);
  const maximizedRef = useRef(false);

  const applyMaximized = useCallback((value: boolean) => {
    maxTicketRef.current += 1;
    maximizedRef.current = value;
    setMaximized(value);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let canceled = false;
    const win = getCurrentWindow();

    const applyMeasuredSize = (
      ticket: number,
      minimizedNow: boolean,
      size: WindowSize,
      scale: number,
    ) => {
      const active = isActiveTicket(canceled, ticket, sizeTicketRef.current);
      if (!active || !shouldApplySize(minimizedNow, size)) return;
      setCompact(isCompactWidth(toLogicalWidth(size.width, scale)));
    };

    const applyMeasuredMaximized = (
      ticket: number,
      minimizedNow: boolean,
      maximizedNow: boolean,
    ) => {
      const active = isActiveTicket(canceled, ticket, maxTicketRef.current);
      if (!active || minimizedNow) return;
      maximizedRef.current = maximizedNow;
      setMaximized(maximizedNow);
    };

    const read = async (event?: { payload?: WindowSize }) => {
      // On Windows (`WM_SIZE` `SIZE_MINIMIZED`), `tao` emits `Resized(0, 0)`
      // and clears `WindowFlags::MAXIMIZED`, while `outerSize()` (`GetWindowRect`)
      // reports the 160x28 iconic taskbar slot. Ignoring zero-dimension resize
      // payloads and minimized windows keeps the bar from flipping to compact
      // or losing its maximized state while minimized.
      if (!hasPositiveDimensions(event?.payload)) return;
      const sizeTicket = ++sizeTicketRef.current;
      const maxTicket = ++maxTicketRef.current;
      try {
        // Prefer `innerSize()` over `outerSize()`: on an undecorated window the
        // webview fills the client area, whereas `outerSize()` on Linux (`tao`
        // 0.34.8) initializes from `root_origin()` and lags `configure-event`
        // via asynchronous `frame_extents()`, and on Windows includes the
        // invisible DWM shadow border and returns 160x28 when minimized.
        const [size, maximizedNow, minimizedNow, scale] = await Promise.all([
          readWindowSize(win),
          win.isMaximized(),
          readWindowMinimized(win),
          win.scaleFactor(),
        ]);
        applyMeasuredSize(sizeTicket, minimizedNow, size, scale);
        applyMeasuredMaximized(maxTicket, minimizedNow, maximizedNow);
      } catch {
        /* the window went away mid-measurement; the next tick re-reads */
      }
    };
    read().catch(() => undefined);

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
  return [maximized, applyMaximized, maximizedRef, compact] as const;
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

const startWindowDrag = () => {
  const win = getCurrentWindow();
  if (typeof win.startDragging === "function") {
    win.startDragging().catch(showErrorSnackbar);
  }
};

const isPrimaryButtonHeld = (buttons: number): boolean => (buttons & 1) !== 0;

const isWithinDragThreshold = (
  origin: DragPoint | null,
  clientX: number,
  clientY: number,
): boolean =>
  origin !== null &&
  Math.hypot(clientX - origin.x, clientY - origin.y) < DRAG_START_DISTANCE_PX;

const isMacDoubleClickRelease = (
  detail: number,
  origin: DragPoint | null,
  clientX: number,
  clientY: number,
): boolean =>
  getPlatform() === "macos" &&
  detail === 2 &&
  isWithinDragThreshold(origin, clientX, clientY);

const bindDeferredDrag = (
  startX: number,
  startY: number,
  cleanupRef: React.MutableRefObject<(() => void) | null>,
) => {
  const controller = new AbortController();
  const cleanup = () => {
    controller.abort();
    if (cleanupRef.current === cleanup) {
      cleanupRef.current = null;
    }
  };

  const handleMove = (moveEvent: MouseEvent) => {
    if (!isPrimaryButtonHeld(moveEvent.buttons)) {
      cleanup();
      return;
    }
    if (
      isWithinDragThreshold(
        { x: startX, y: startY },
        moveEvent.clientX,
        moveEvent.clientY,
      )
    ) {
      return;
    }
    cleanup();
    startWindowDrag();
  };

  cleanupRef.current = cleanup;
  window.addEventListener("mousemove", handleMove, {
    signal: controller.signal,
  });
  window.addEventListener("mouseup", cleanup, {
    capture: true,
    signal: controller.signal,
  });
  window.addEventListener("blur", cleanup, {
    signal: controller.signal,
  });
};

const beginPlatformDrag = (
  startX: number,
  startY: number,
  cleanupRef: React.MutableRefObject<(() => void) | null>,
) => {
  if (!isTauriRuntime()) return;
  // On macOS, `tao`'s `drag_window()` passes `NSApp.currentEvent()` to
  // `-[NSWindow performWindowDragWithEvent:]`, which requires the current
  // AppKit event to be `LeftMouseDown`; AppKit's WindowServer natively waits
  // for pointer movement before moving the window. On Windows and Linux,
  // starting the OS move loop before pointer movement swallows `mouseup`
  // (tauri#10767) and unmaximizes on a stationary click (tauri#11945).
  if (getPlatform() === "macos") {
    startWindowDrag();
    return;
  }
  bindDeferredDrag(startX, startY, cleanupRef);
};

const useWindowControls = (
  applyMaximized: (value: boolean) => void,
  maximizedRef: React.MutableRefObject<boolean>,
) => {
  const togglePendingRef = useRef(false);

  const minimize = useCallback(
    () =>
      runWindowControl(async () => {
        if (!isTauriRuntime()) return;
        await getCurrentWindow().minimize();
      }),
    [],
  );

  const toggleMax = useCallback(() => {
    if (!isTauriRuntime() || togglePendingRef.current) return;
    const win = getCurrentWindow();
    const previous = maximizedRef.current;
    const next = !previous;
    togglePendingRef.current = true;
    maximizedRef.current = next;
    (next ? win.maximize() : win.unmaximize())
      .then(() => {
        applyMaximized(next);
      })
      .catch((error: unknown) => {
        maximizedRef.current = previous;
        showErrorSnackbar(error);
      })
      .finally(() => {
        togglePendingRef.current = false;
      });
  }, [applyMaximized, maximizedRef]);

  const close = useCallback(
    () =>
      runWindowControl(async () => {
        if (!isTauriRuntime()) return;
        await getCurrentWindow().close();
      }),
    [],
  );

  const dragCleanupRef = useRef<(() => void) | null>(null);
  const doubleClickOriginRef = useRef<DragPoint | null>(null);
  const skipNextDblClickRef = useRef(false);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const onDragRegionMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Prevent text selection on double-click and stop propagation before the
      // event bubbles from the React root to `document`, where Tauri's injected
      // `drag.js` listener lives.
      event.preventDefault();
      event.stopPropagation();
      dragCleanupRef.current?.();
      skipNextDblClickRef.current = false;

      // The second press of a double-click is handled by `onDoubleClick` (or
      // `onDragRegionMouseUp` on macOS); never start a drag on a multi-click.
      if (event.detail >= 2) {
        doubleClickOriginRef.current = { x: event.clientX, y: event.clientY };
        return;
      }
      doubleClickOriginRef.current = null;
      beginPlatformDrag(event.clientX, event.clientY, dragCleanupRef);
    },
    [],
  );

  const onDragRegionMouseUp = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // On macOS, Tauri's `drag.js` invokes `internal_toggle_maximize` from a
      // document-level `mouseup` listener when `detail === 2`. Stopping
      // propagation here prevents `drag.js` from double-toggling.
      event.stopPropagation();
      dragCleanupRef.current?.();
      const origin = doubleClickOriginRef.current;
      doubleClickOriginRef.current = null;
      // On macOS, `performWindowDragWithEvent:` on the first press consumes the
      // first `mouseup` in AppKit, so WebKit may not synthesize `dblclick` on
      // the second release even though `mouseup` arrives with `detail === 2`.
      if (
        isMacDoubleClickRelease(
          event.detail,
          origin,
          event.clientX,
          event.clientY,
        )
      ) {
        skipNextDblClickRef.current = true;
        toggleMax();
      }
    },
    [toggleMax],
  );

  const onDragRegionDoubleClick = useCallback(() => {
    if (skipNextDblClickRef.current) {
      skipNextDblClickRef.current = false;
      return;
    }
    toggleMax();
  }, [toggleMax]);

  return {
    minimize,
    toggleMax,
    close,
    onDragRegionMouseDown,
    onDragRegionMouseUp,
    onDragRegionDoubleClick,
  };
};

/**
 * Hover and press share one pair of tokens, press being the stronger of the two.
 *
 * All three buttons resolve their fill through here, which is what keeps close
 * from being special-cased. See `captionButtonHover` for why it must not be.
 */
const captionButtonFill = (dark: boolean, pressed: boolean): string => {
  const fills = pressed ? captionButtonActive : captionButtonHover;

  return dark ? fills.dark : fills.light;
};

/**
 * The window-control buttons, sized and coloured off one factory.
 *
 * Square targets inset from the bar edges rather than flush strips, so the
 * bar's own material is visible between them and against the window edge. That
 * is what separates a control cluster from a row of divider lines.
 */
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
    // `styles/caption.css` instead. The transition reads the shared duration
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

const leftClusterSx = (trafficLights: boolean, focused: boolean) =>
  ({
    alignItems: "center",
    position: "relative",
    zIndex: 1,
    pl: trafficLights ? 1 : 0.5,
    color: "text.primary",
    opacity: focused ? 1 : 0.6,
    pointerEvents: "none",
  }) as const;

const resolveTitleBarPlatform = () =>
  isTauriRuntime() ? getPlatform() : "unknown";

export const TitleBar = () => {
  const dark = useIsDarkMode();
  const intl = useIntl();
  // Same predicate the resize grips use, so the chrome and the grips can never
  // disagree. Browser preview ("unknown") gets right-side caption buttons.
  const trafficLights = !hasRightCaptionButtons(resolveTitleBarPlatform());
  // Maximized flag and bar density come from one subscription: they change in
  // the same event, so reading them separately issued duplicated IPC on every
  // tick of a resize drag.
  const [maximized, setMaximized, maximizedRef, compact] = useWindowMetrics();
  const focused = useWindowFocused();
  const {
    minimize,
    toggleMax,
    close,
    onDragRegionMouseDown,
    onDragRegionMouseUp,
    onDragRegionDoubleClick,
  } = useWindowControls(setMaximized, maximizedRef);

  const minimizeLabel = intl.formatMessage({ defaultMessage: "Minimize" });
  const maximizeLabel = maximized
    ? intl.formatMessage({ defaultMessage: "Restore" })
    : intl.formatMessage({ defaultMessage: "Maximize" });
  const closeLabel = intl.formatMessage({ defaultMessage: "Close" });

  return (
    <>
      <WindowResizeHandles disabled={maximized} />
      <Box data-focused={focused} sx={titleBarSx(dark, trafficLights)}>
        {/*
          Full-bleed drag region. Mouse events are stopped from bubbling to
          Tauri's document-level `drag.js` listener so stationary clicks do not
          unmaximize the window and double-clicks do not fire both
          `internal_toggle_maximize` and `toggleMax`.
        */}
        <Box
          data-tauri-drag-region
          onMouseDown={onDragRegionMouseDown}
          onMouseUp={onDragRegionMouseUp}
          onDoubleClick={onDragRegionDoubleClick}
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
          sx={leftClusterSx(trafficLights, focused)}
        >
          <Box sx={{ display: "inline-flex", pointerEvents: "auto" }}>
            <ThemeModeToggle />
          </Box>
          <LogoWithText compact={compact} />
        </Stack>

        <Box sx={{ flex: 1, pointerEvents: "none" }} />

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
