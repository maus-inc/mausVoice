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
export const CAPTION_BUTTON_SIZE = 34;

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

/**
 * Logical CSS-pixel width at or below which the bar drops to its compact form.
 *
 * The window's configured `minWidth` is 800, so any threshold below that can
 * never fire and the compact form would be dead code. 900 sits above the
 * minimum and below the 1100 default, which is the range a user actually
 * reaches when they narrow the window.
 *
 * Compare this against a logical width, not the physical width Tauri reports.
 */
export const COMPACT_WIDTH = 900;

/** Caption button side in the compact form. Still above `MIN_TARGET_SIZE`. */
export const COMPACT_CAPTION_BUTTON_SIZE = 30;

/**
 * Whether the bar should render compact for a given window width.
 *
 * `width` is in logical CSS pixels. `null` means the size is not known yet,
 * which renders the roomy default so the bar never flashes compact on first
 * paint.
 */
export const isCompactWidth = (width: number | null): boolean =>
  width !== null && width > 0 && width <= COMPACT_WIDTH;

/*
 * The derived helper below reads the constants above, so it sits after every one
 * of them is declared. A helper that named a later constant would work at
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
