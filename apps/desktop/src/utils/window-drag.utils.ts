/**
 * Where a title-bar grab point lands inside a restored window, and how far the
 * window has to move to put that point back under the pointer.
 *
 * The bar is not part of the window's geometry for this purpose. The point is
 * carried as a fraction across the window and a pixel offset down from its
 * top, then read back at the restored size. A fraction rather than a pixel
 * offset across, because the restored window is narrower than the maximized
 * one and the grab point has to keep its relative place along the bar.
 *
 * Every value here is in physical pixels, which is the only unit Tauri reports
 * window position, window size, the pointer and the monitor work area in. The
 * caller converts the browser's CSS-pixel press into that space once, by its
 * scale factor, before building a `RestoreGrab`. Mixing the two units is what
 * makes a restore land off the pointer on a scaled display.
 */
export type RestoreGrab = {
  /** Grab point as a fraction of the window width, clamped to 0..1. */
  fractionX: number;
  /** Grab point in px below the window top, clamped to the window height. */
  offsetY: number;
};

type Point = { x: number; y: number };
type Size = { width: number; height: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Reads a grab point out of the window the OS is about to restore.
 *
 * `grab` must be in the same space as `size`. A zero or negative width cannot
 * produce a fraction, so the window is treated as grabbed at its left edge
 * rather than dividing by zero.
 */
export const grabPoint = (grab: Point, size: Size): RestoreGrab => ({
  fractionX: size.width > 0 ? clamp(grab.x / size.width, 0, 1) : 0,
  offsetY: clamp(grab.y, 0, Math.max(size.height, 0)),
});

/**
 * Top-left corner that puts the grab point back under the pointer at the
 * restored size.
 *
 * The top is clamped to the top of the work area. A grab low on the bar would
 * otherwise place the bar above the visible screen, and the window would then
 * have no reachable drag region of its own.
 */
export const restoredPosition = (
  grab: RestoreGrab,
  size: Size,
  pointer: Point,
  workAreaOrigin: Point,
): Point => ({
  x: pointer.x - grab.fractionX * size.width,
  y: Math.max(pointer.y - grab.offsetY, workAreaOrigin.y),
});
