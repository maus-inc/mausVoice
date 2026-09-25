/**
 * Single source of truth for the custom title bar geometry. The resize grips
 * in `WindowResizeHandles` and their tests read these values, so if the
 * caption buttons change size the grips move with them.
 */

/** Height of the custom title bar (and of each caption button). */
export const TITLE_BAR_HEIGHT = 40;

/** Width of each Windows/Linux caption button (minimize, maximize, close). */
export const CAPTION_BUTTON_WIDTH = 46;

/**
 * Windows and Linux render caption buttons flush against the right window
 * edge; macOS renders traffic lights on the left instead.
 */
export const hasRightCaptionButtons = (platform: string): boolean =>
  platform !== "macos";
