import { describe, expect, it } from "vitest";
import {
  CAPTION_CLUSTER_PAD_RIGHT,
  captionButtonSize,
  captionClusterWidth,
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

/** Resolve one axis of the generated grip positions into absolute bounds. */
const axisBounds = (
  extent: number,
  start?: number,
  end?: number,
  size?: number,
): [number, number] => {
  const leading = start ?? extent - (end ?? 0) - (size ?? 0);
  return [leading, size !== undefined ? leading + size : extent - (end ?? 0)];
};

const toRect = (p: Record<string, number>): Rect => {
  const [left, right] = axisBounds(WINDOW.width, p.left, p.right, p.width);
  const [top, bottom] = axisBounds(WINDOW.height, p.top, p.bottom, p.height);
  return { left, top, right, bottom };
};

it("resolves explicit dimensions and opposing anchors, including zero", () => {
  expect(toRect({ left: 0, top: 0, width: 10, height: 20 })).toEqual({
    left: 0,
    top: 0,
    right: 10,
    bottom: 20,
  });
  expect(toRect({ right: 5, bottom: 7, width: 10, height: 20 })).toEqual({
    left: 985,
    top: 673,
    right: 995,
    bottom: 693,
  });
  expect(toRect({ left: 10, right: 20, top: 5, bottom: 7 })).toEqual({
    left: 10,
    top: 5,
    right: 980,
    bottom: 693,
  });
  expect(toRect({ left: 10, top: 5, width: 0, height: 0 })).toEqual({
    left: 10,
    top: 5,
    right: 10,
    bottom: 5,
  });
});

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const gripRect = (grips: ReturnType<typeof getGrips>, direction: string) => {
  const grip = grips.find((g) => g.direction === direction);
  if (!grip) throw new Error(`Expected a grip for direction "${direction}"`);
  return toRect(grip.position);
};

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

  it("leave the close button clickable below the top frame row", () => {
    // Geometry comes from titleBarGeometry, the same source TitleBar uses, so
    // resizing the caption buttons moves this guard with them. The cluster is
    // three inset squares plus gaps and trailing padding, so the close button
    // stops short of the window edge by that trailing padding.
    const clickable: Rect = {
      left: WINDOW.width - CAPTION_CLUSTER_PAD_RIGHT - captionButtonSize(false),
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
    // The row spans the whole bar. Its buttons are centred inside it by CSS, so
    // pinning a vertical position here would only add a second copy of that
    // rule for the assertion to drift from.
    const captionRow: Rect = {
      left: WINDOW.width - captionClusterWidth(false),
      top: 0,
      right: WINDOW.width,
      bottom: TITLE_BAR_HEIGHT,
    };
    for (const grip of grips) {
      const rect = toRect(grip.position);
      if (!overlaps(rect, captionRow)) continue;
      expect(rect.bottom, grip.direction).toBeLessThanOrEqual(FRAME);
    }
  });

  it("keeps top-right diagonal resize acquirable along the top edge", () => {
    const rect = gripRect(grips, "NorthEast");
    // A frame-sized square is too small to hit reliably; the strip spans the
    // full corner width (derived from the shared constant, not a literal).
    expect(rect.right - rect.left).toBe(CORNER);
    expect(rect.right).toBe(WINDOW.width);
    expect(rect.top).toBe(0);
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
    const rect = gripRect(grips, "NorthEast");
    expect(rect.right - rect.left).toBe(CORNER);
    expect(rect.bottom - rect.top).toBe(CORNER);
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
