/**
 * Turning a provider's coordinate space into physical pixels on the display.
 *
 * Each provider states where a point lands in its own terms, and no two terms
 * agree: one asks for a point on a fixed grid that never mentions the screen,
 * the other asks for a pixel inside the image the model was just shown. Both
 * land in the same place only after being measured against something, and that
 * something is the physical display.
 *
 * Everything here rounds and clamps. A coordinate that lands a pixel outside
 * the display is not a rounding curiosity, it is a click on nothing, or a drag
 * that starts off-window, and the provider never learns it was wrong.
 */

/**
 * The edge of the grid one provider's coordinates are expressed on.
 *
 * The documentation describes the range as 0 to 999 and divides by 1000 in its
 * own sample code. The divisor is the one that code uses, and dividing by 999
 * instead would put the far corner one full pixel past the display.
 */
export const NORMALIZED_GRID_SIZE = 1000;

/** Round to the nearest pixel and keep the result on the display. */
export const clampToDisplay = (value: number, displayExtent: number): number => {
  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  return rounded > displayExtent - 1 ? displayExtent - 1 : rounded;
};

/**
 * A point on the fixed grid, as a physical pixel on the display.
 *
 * The grid is resolution-independent, so the same point names a different pixel
 * on a different monitor. That is why the display extent is an argument rather
 * than something the session remembers.
 */
export const denormalizeGridCoordinate = (
  value: number,
  displayExtent: number,
): number => clampToDisplay((value / NORMALIZED_GRID_SIZE) * displayExtent, displayExtent);

/**
 * A pixel inside the image the model was shown, as a physical pixel.
 *
 * Providers that scale coordinates this way are describing where a point sits
 * in the capture, not on the screen. A downscaled capture is the normal case
 * here, so passing the capture's own width as the denominator is what makes the
 * click land where the model looked.
 */
export const scaleCaptureCoordinate = (
  value: number,
  captureExtent: number,
  displayExtent: number,
): number => clampToDisplay((value / captureExtent) * displayExtent, displayExtent);