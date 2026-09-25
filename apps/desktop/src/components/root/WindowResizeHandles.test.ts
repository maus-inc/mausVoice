import { describe, expect, it } from "vitest";
import { GRIPS } from "./WindowResizeHandles";

const WINDOW = { width: 1000, height: 700 };
/** Windows/Linux close caption button: flush right, 46×40 (see TitleBar). */
const CLOSE = {
  left: WINDOW.width - 46,
  top: 0,
  right: WINDOW.width,
  bottom: 40,
};
/** Outermost frame pixels that may legitimately stay a resize target. */
const FRAME = 4;

const toRect = (p: Record<string, number>) => {
  const left = p.left ?? WINDOW.width - (p.right ?? 0) - (p.width ?? 0);
  const top = p.top ?? WINDOW.height - (p.bottom ?? 0) - (p.height ?? 0);
  const right =
    p.width !== undefined ? left + p.width : WINDOW.width - (p.right ?? 0);
  const bottom =
    p.height !== undefined ? top + p.height : WINDOW.height - (p.bottom ?? 0);
  return { left, top, right, bottom };
};

describe("WindowResizeHandles grips", () => {
  it("leave the flush close button clickable outside the frame corner", () => {
    // Area of the close button that must never be covered by a resize grip:
    // everything below the top 4px frame row, including the rightmost column
    // (the East grip must not swallow clicks along the window edge).
    const clickable = {
      left: CLOSE.left,
      top: FRAME,
      right: CLOSE.right,
      bottom: CLOSE.bottom,
    };
    for (const grip of GRIPS) {
      const r = toRect(grip.position);
      const overlaps =
        r.left < clickable.right &&
        r.right > clickable.left &&
        r.top < clickable.bottom &&
        r.bottom > clickable.top;
      expect(overlaps, grip.direction).toBe(false);
    }
  });

  it("keeps the right-edge corner grip within the frame", () => {
    const ne = GRIPS.find((g) => g.direction === "NorthEast")!;
    const r = toRect(ne.position);
    expect(r.right - r.left).toBeLessThanOrEqual(FRAME);
    expect(r.bottom - r.top).toBeLessThanOrEqual(FRAME);
  });

  it("covers every edge and corner", () => {
    expect(GRIPS.map((g) => g.direction).sort()).toEqual(
      [
        "East",
        "North",
        "NorthEast",
        "NorthWest",
        "South",
        "SouthEast",
        "SouthWest",
        "West",
      ].sort(),
    );
  });
});
