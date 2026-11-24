import type { Platform } from "../../utils/platform.utils";

/**
 * Single source of truth for the custom title bar geometry. The resize grips
 * in `WindowResizeHandles` and their tests read these values, so if the
 * caption buttons change size the grips move with them.
 */

/**
 * Resize grip edge thickness in px. Matches the hit area a native frame would
 * expose, intentionally thin so it never steals clicks from real content.
 */
export const EDGE = 4;

/** Corner grip size in px, larger so diagonal resize stays reachable. */
export const CORNER = 12;

/** Height of the custom title bar. */
export const TITLE_BAR_HEIGHT = 40;

/**
 * Side of each Windows/Linux caption button (minimize, maximize, close).
 *
 * Square rather than full-height: the cluster is three rounded targets centred
 * in the bar, not three flush strips. That leaves the bar's own material
 * visible between the buttons and against the window edge, which is what
 * separates a native-style cluster from a stack of divider lines.
 */
const CAPTION_BUTTON_SIZE = 34;

/**
 * Corner radius of a caption button.
 *
 * Matches the radius the sidebar and toolbar buttons use, so the cluster reads
 * as one control family instead of three bespoke chrome shapes.
 */
export const CAPTION_BUTTON_RADIUS = 12;

/**
 * Gap between caption buttons, and the padding from the cluster's right edge to
 * the window edge. Both live here so the resize grips' guard and the rendered
 * cluster cannot drift apart.
 */
export const CAPTION_CLUSTER_GAP = 2;
export const CAPTION_CLUSTER_PAD_RIGHT = 2;

/**
 * Windows and Linux render caption buttons flush against the right window
 * edge; macOS renders traffic lights on the left instead.
 */
export const hasRightCaptionButtons = (platform: Platform): boolean =>
  platform !== "macos";

/**
 * Minimum target size in px. WCAG 2.2 Success Criterion 2.5.8 requires every
 * pointer target to be at least 24 by 24, measured on the clickable box rather
 * than the painted glyph.
 */
export const MIN_TARGET_SIZE = 24;

/**
 * Diameter of a macOS traffic light's painted dot. This is the native
 * proportion and stays small on purpose; only the hit area has to be large.
 */
export const TRAFFIC_DOT_SIZE = 12;

/**
 * Clickable box around each traffic light. Must be at least `MIN_TARGET_SIZE`
 * so the controls are acquirable on a trackpad and pass the WCAG 2.2 target
 * size minimum.
 */
export const TRAFFIC_HIT_SIZE = Math.max(MIN_TARGET_SIZE, TRAFFIC_DOT_SIZE);

/** Gap between macOS traffic light hit boxes in roomy vs. compact chrome. */
export const TRAFFIC_CLUSTER_GAP = 8;
export const COMPACT_TRAFFIC_CLUSTER_GAP = 6;

/** Caption button side in the compact form. Still above `MIN_TARGET_SIZE`. */
export const COMPACT_CAPTION_BUTTON_SIZE = 30;

/** Square side of `ThemeModeToggle` in px. */
const THEME_TOGGLE_SIZE = 28;

/** Rendered inline width of the `1.4rem` `Logo` mark (22.4px rounded up). */
const LOGO_MARK_SIZE = 23;

/** Gap between `Logo` mark and `"mausVoice"` wordmark in roomy vs. compact chrome. */
export const LOGO_WORDMARK_GAP = 6;
export const COMPACT_LOGO_WORDMARK_GAP = 5;

/**
 * Full inline width of the `"mausVoice"` wordmark in `TAN-PARADISO` at `0.85rem`
 * (measured at 79.3px in Chromium, rounded up with subpixel slack).
 */
const LOGO_WORDMARK_WIDTH = 82;

/**
 * Minimum inline space where a truncated wordmark (`"maus…"`) still reads as
 * the product name. Below this budget the wordmark hides cleanly so the mark,
 * theme toggle, drag region, and window controls never crowd.
 */
const MIN_WORDMARK_VISIBLE_WIDTH = 48;

/**
 * Minimum open drag/double-click span preserved between the left branding
 * cluster and the right caption cluster (or right bar edge on macOS).
 */
export const MIN_DRAG_REGION_WIDTH = 48;

/**
 * Open drag span above which the bar keeps its roomy padding and 34px caption
 * buttons. Below this budget, controls tighten to reclaim drag space while
 * keeping `"mausVoice"` visible.
 */
const ROOMY_DRAG_REGION_TARGET = 360;

/*
 * The derived helpers below read the constants above, so they sit after every
 * one of them is declared. A helper that named a later constant would work at
 * runtime and still be a trap for the next reader.
 *
 * The cluster's vertical position is deliberately absent. The bar centres it
 * with `alignItems`, so a constant here would be a second copy of that rule that
 * no test could keep honest. Reason about the row vertically in terms of the top
 * frame band instead.
 */

/** Side of one caption button in a given bar density. */
export const captionButtonSize = (compact: boolean): number =>
  compact ? COMPACT_CAPTION_BUTTON_SIZE : CAPTION_BUTTON_SIZE;

/**
 * Width the whole cluster occupies, right edge of the window included.
 *
 * The cluster is three inset squares with gaps, not three flush strips, so its
 * width is not three button sizes. Anything reasoning about where the cluster
 * ends has to use this.
 */
export const captionClusterWidth = (compact: boolean): number =>
  3 * captionButtonSize(compact) +
  2 * CAPTION_CLUSTER_GAP +
  CAPTION_CLUSTER_PAD_RIGHT;

/** Width of the three macOS traffic light hit targets and the gaps between them. */
const trafficLightsClusterWidth = (compact: boolean): number =>
  3 * TRAFFIC_HIT_SIZE +
  2 * (compact ? COMPACT_TRAFFIC_CLUSTER_GAP : TRAFFIC_CLUSTER_GAP);

/**
 * Horizontal space occupied by padding, window controls, theme toggle, and the
 * logo mark — everything in the bar except the wordmark (and its gap) and the
 * open middle drag span.
 */
const titleBarFixedChromeWidth = (
  platform: Platform,
  compact: boolean,
): number => {
  if (hasRightCaptionButtons(platform)) {
    const barLeftPad = compact ? 6 : 8;
    const clusterLeftPad = compact ? 2 : 4;
    const toggleToLogoGap = compact ? 6 : 8;
    return (
      barLeftPad +
      clusterLeftPad +
      THEME_TOGGLE_SIZE +
      toggleToLogoGap +
      LOGO_MARK_SIZE +
      captionClusterWidth(compact)
    );
  }
  const barSidePad = compact ? 10 : 12;
  const clusterLeftPad = compact ? 6 : 8;
  const toggleToLogoGap = compact ? 6 : 8;
  return (
    barSidePad +
    trafficLightsClusterWidth(compact) +
    clusterLeftPad +
    THEME_TOGGLE_SIZE +
    toggleToLogoGap +
    LOGO_MARK_SIZE +
    barSidePad
  );
};

/**
 * Logical width at or below which the bar tightens control spacing and caption
 * button size while keeping the wordmark visible.
 */
export const compactChromeThreshold = (platform: Platform): number =>
  titleBarFixedChromeWidth(platform, false) +
  LOGO_WORDMARK_GAP +
  LOGO_WORDMARK_WIDTH +
  ROOMY_DRAG_REGION_TARGET;

/**
 * Logical width at or below which even a truncated wordmark no longer has
 * `MIN_WORDMARK_VISIBLE_WIDTH` alongside controls and `MIN_DRAG_REGION_WIDTH`.
 */
export const wordmarkHideThreshold = (platform: Platform): number =>
  titleBarFixedChromeWidth(platform, true) +
  COMPACT_LOGO_WORDMARK_GAP +
  MIN_WORDMARK_VISIBLE_WIDTH +
  MIN_DRAG_REGION_WIDTH -
  1;

/**
 * Whether the bar should tighten control spacing and caption button size.
 *
 * `width` is in logical CSS pixels. `null` means the size is not known yet,
 * which renders the roomy default so the bar never flashes compact on first
 * paint.
 */
export const isCompactWidth = (
  width: number | null,
  platform: Platform = "unknown",
): boolean =>
  width !== null && width > 0 && width <= compactChromeThreshold(platform);

/**
 * Whether the `"mausVoice"` wordmark must hide because horizontal space has
 * dropped below the readable truncation floor.
 */
export const isWordmarkHidden = (
  width: number | null,
  platform: Platform = "unknown",
): boolean =>
  width !== null && width > 0 && width <= wordmarkHideThreshold(platform);
