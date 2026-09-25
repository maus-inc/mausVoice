import { describe, expect, it } from "vitest";
import {
  CAPTION_BUTTON_WIDTH,
  hasRightCaptionButtons,
  TITLE_BAR_HEIGHT,
} from "./titleBarGeometry";
import { getGrips } from "./WindowResizeHandles";

const WINDOW = { width: 1000, height: 700 };
/** Outermost frame pixels that may legitimately stay a resize target. */
const FRAME = 4;

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

  it("keeps the NorthEast grip within the frame corner", () => {
    const r = gripRect(grips, "NorthEast");
    expect(r.right - r.left).toBeLessThanOrEqual(FRAME);
    expect(r.bottom - r.top).toBeLessThanOrEqual(FRAME);
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

  it("keeps the regular 12px NorthEast corner", () => {
    const r = gripRect(grips, "NorthEast");
    expect(r.right - r.left).toBe(12);
    expect(r.bottom - r.top).toBe(12);
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
