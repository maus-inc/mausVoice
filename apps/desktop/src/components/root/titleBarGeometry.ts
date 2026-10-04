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

/** Height of the custom title bar (and of each caption button). */
export const TITLE_BAR_HEIGHT = 40;

/** Width of each Windows/Linux caption button (minimize, maximize, close). */
export const CAPTION_BUTTON_WIDTH = 46;

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

/** Caption button width in the compact form. Still above `MIN_TARGET_SIZE`. */
export const COMPACT_CAPTION_BUTTON_WIDTH = 34;

/**
 * Whether the bar should render compact for a given window width.
 *
 * `width` is in logical CSS pixels. `null` means the size is not known yet,
 * which renders the roomy default so the bar never flashes compact on first
 * paint.
 */
export const isCompactWidth = (width: number | null): boolean =>
  width !== null && width > 0 && width <= COMPACT_WIDTH;
