import { describe, expect, it } from "vitest";
import {
  CAPTION_BUTTON_WIDTH,
  CORNER,
  EDGE,
  hasRightCaptionButtons,
  TITLE_BAR_HEIGHT,
} from "./titleBarGeometry";
import { getGrips } from "./WindowResizeHandles";

const WINDOW = { width: 1000, height: 700 };
/**
 * Height of the top frame band. On Windows/Linux this band is intentionally a
 * resize target across the caption buttons (like a native Windows frame's top
 * border); everything below it must belong to the buttons. See getGrips.
 */
const FRAME = EDGE;

type Rect = { left: number; top: number; right: number; bottom: number };

const toRect = (p: Record<string, number>): Rect => {
  const left = p.left ?? WINDOW.width - (p.right ?? 0) - (p.width ?? 0);
  const top = p.top ?? WINDOW.height - (p.bottom ?? 0) - (p.height ?? 0);
  const right =
    p.width !== undefined ? left + p.width : WINDOW.width - (p.right ?? 0);
  const bottom =
    p.height !== undefined ? top + p.height : WINDOW.height - (p.bottom ?? 0);
  return { left, top, right, bottom };
};

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const gripRect = (grips: ReturnType<typeof getGrips>, direction: string) =>
  toRect(grips.find((g) => g.direction === direction)!.position);

describe("hasRightCaptionButtons", () => {
  it.each([
    ["windows", true],
    ["linux", true],
    ["macos", false],
    ["unknown", true],
  ] as const)("%s -> %s", (platform, expected) => {
    expect(hasRightCaptionButtons(platform)).toBe(expected);
  });
});

describe("getGrips with right-side caption buttons (Windows/Linux)", () => {
  const grips = getGrips(true);

  it("leave the flush close button clickable below the top frame row", () => {
    // Geometry comes from titleBarGeometry, the same source TitleBar uses, so
    // resizing the caption buttons moves this guard with them.
    const clickable: Rect = {
      left: WINDOW.width - CAPTION_BUTTON_WIDTH,
      top: FRAME,
      right: WINDOW.width,
      bottom: TITLE_BAR_HEIGHT,
    };
    for (const grip of grips) {
      expect(overlaps(toRect(grip.position), clickable), grip.direction).toBe(
        false,
      );
    }
  });

  it("keeps every grip over the caption row inside the top frame band", () => {
    const captionRow: Rect = {
      left: WINDOW.width - 3 * CAPTION_BUTTON_WIDTH,
      top: 0,
      right: WINDOW.width,
      bottom: TITLE_BAR_HEIGHT,
    };
    for (const grip of grips) {
      const r = toRect(grip.position);
      if (!overlaps(r, captionRow)) continue;
      expect(r.bottom, grip.direction).toBeLessThanOrEqual(FRAME);
    }
  });

  it("keeps top-right diagonal resize acquirable along the top edge", () => {
    const r = gripRect(grips, "NorthEast");
    // A frame-sized square is too small to hit reliably; the strip spans the
    // full corner width (derived from the shared constant, not a literal).
    expect(r.right - r.left).toBe(CORNER);
    expect(r.right).toBe(WINDOW.width);
    expect(r.top).toBe(0);
  });

  it("starts the East grip directly below the caption row", () => {
    expect(gripRect(grips, "East").top).toBe(TITLE_BAR_HEIGHT);
  });
});

describe("getGrips without right-side caption buttons (macOS)", () => {
  const grips = getGrips(false);

  it("keeps the full right edge resizable", () => {
    const east = gripRect(grips, "East");
    const northEast = gripRect(grips, "NorthEast");
    // East picks up exactly where the NorthEast corner ends: no dead band.
    expect(east.top).toBe(northEast.bottom);
    expect(east.top).toBeLessThan(TITLE_BAR_HEIGHT);
  });

  it("keeps the regular square NorthEast corner", () => {
    const r = gripRect(grips, "NorthEast");
    expect(r.right - r.left).toBe(CORNER);
    expect(r.bottom - r.top).toBe(CORNER);
  });
});

it.each([true, false])(
  "covers every edge and corner (right captions: %s)",
  (rightCaptions) => {
    expect(
      getGrips(rightCaptions)
        .map((g) => g.direction)
        .sort(),
    ).toEqual(
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
  },
);
