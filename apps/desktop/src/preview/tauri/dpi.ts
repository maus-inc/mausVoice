/**
 * Browser-preview stand-in for `@tauri-apps/api/dpi`.
 *
 * The real module exports classes so that a position or size can be handed to
 * the IPC layer tagged as logical or physical. The preview has no IPC layer, so
 * all this has to do is carry `x`/`y` and `width`/`height` through unchanged,
 * which keeps the call sites identical in both builds.
 */
export class LogicalPosition {
  public x: number;
  public y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class LogicalSize {
  public width: number;
  public height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}
