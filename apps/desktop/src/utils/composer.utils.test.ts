import { describe, expect, it } from "vitest";
import { computeComposerRect, type Rect, type Size } from "./composer.utils";

const size: Size = { width: 560, height: 420 };

const monitor = (overrides: Partial<Rect> = {}): Rect => ({
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  ...overrides,
});

describe("computeComposerRect", () => {
  it("places the composer below the pill for normal positive coordinates", () => {
    const pill: Rect = { x: 1200, y: 600, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, monitor());
    expect(result).toEqual({ x: 1200, y: 648 });
  });

  it("keeps the composer on-screen on a negative multi-monitor layout", () => {
    const negativeMonitor = monitor({
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    });
    const pill: Rect = { x: -800, y: 500, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, negativeMonitor);

    expect(result.x).toBeGreaterThanOrEqual(-1920);
    expect(result.x + size.width).toBeLessThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.y + size.height).toBeLessThanOrEqual(1080);
    expect(result).toEqual({ x: -800, y: 548 });
  });

  it("places the composer to the left of the pill when hugging the right edge", () => {
    const pill: Rect = { x: 1850, y: 500, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, monitor());

    // Right edge would overflow, so it anchors to the left of the pill.
    expect(result.x + size.width).toBeLessThanOrEqual(1920);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result).toEqual({ x: 1282, y: 500 });
  });

  it("clamps into the monitor bounds when no side fully fits", () => {
    const pill: Rect = { x: 1700, y: 700, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, monitor());

    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + size.width).toBeLessThanOrEqual(1920);
    expect(result.y + size.height).toBeLessThanOrEqual(1080);
    expect(result).toEqual({ x: 1360, y: 660 });
  });

  it("places the composer below and left-aligned to the pill at the left edge", () => {
    const pill: Rect = { x: 10, y: 500, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, monitor());

    expect(result.x).toBe(pill.x);
    expect(result.y).toBe(pill.y + pill.height + 8);
    expect(result).toEqual({ x: 10, y: 548 });
  });

  it("stays within bounds for a negative monitor near its bottom edge", () => {
    const negativeMonitor = monitor({
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    });
    const pill: Rect = { x: -300, y: 1000, width: 120, height: 40 };
    const result = computeComposerRect(pill, size, negativeMonitor);

    expect(result.x).toBeGreaterThanOrEqual(-1920);
    expect(result.x + size.width).toBeLessThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.y + size.height).toBeLessThanOrEqual(1080);
  });
});
