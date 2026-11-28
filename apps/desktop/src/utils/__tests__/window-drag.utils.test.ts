import { describe, expect, it } from "vitest";
import {
  grabPoint,
  restoredPosition,
  type RestoreGrab,
} from "../window-drag.utils";

const maximized = { width: 1920, height: 1040 };

describe("grabPoint", () => {
  it("carries the grab point as a fraction across the window", () => {
    // A press a quarter of the way along a maximized bar is a quarter of the
    // way along the restored one, which is what keeps the pointer on the bar
    // after the width changes.
    expect(grabPoint({ x: 480, y: 20 }, maximized).fractionX).toBeCloseTo(0.25);
    expect(grabPoint({ x: 960, y: 20 }, maximized).fractionX).toBeCloseTo(0.5);
  });

  it("keeps the distance below the window top in pixels", () => {
    expect(grabPoint({ x: 480, y: 18 }, maximized).offsetY).toBe(18);
  });

  it("clamps both axes to the window", () => {
    // The press is inside the client area, so these only fire on a stale
    // measurement. Clamping keeps a bad reading from placing the window off
    // its own bar instead of propagating it.
    expect(grabPoint({ x: -40, y: -10 }, maximized)).toEqual({
      fractionX: 0,
      offsetY: 0,
    });
    expect(grabPoint({ x: 4000, y: 9000 }, maximized)).toEqual({
      fractionX: 1,
      offsetY: maximized.height,
    });
  });

  it("treats an unmeasurable width as a grab at the left edge", () => {
    // Dividing by a zero width yields NaN, which would reach `setPosition` as
    // a coordinate the OS rejects.
    expect(grabPoint({ x: 100, y: 20 }, { width: 0, height: 0 })).toEqual({
      fractionX: 0,
      offsetY: 0,
    });
  });
});

describe("restoredPosition", () => {
  // Physical pixels throughout, because that is the only unit the caller can
  // read the window, the pointer and the work area in.
  const grab: RestoreGrab = { fractionX: 0.25, offsetY: 18 };
  const restored = { width: 1100, height: 700 };

  it("puts the grab point back under the pointer at the restored size", () => {
    const position = restoredPosition(
      grab,
      restored,
      { x: 300, y: 400 },
      { x: 0, y: 0 },
    );
    // The window's left edge is one restored width's fraction before the
    // pointer, and its top one grab offset above it.
    expect(position).toEqual({ x: 300 - 0.25 * 1100, y: 400 - 18 });
  });

  it("applies the same rule on a monitor offset from the origin", () => {
    // A second monitor to the left has a negative work-area origin, and the
    // clamp must read that origin rather than `0`.
    const position = restoredPosition(
      grab,
      restored,
      { x: -1600, y: 100 },
      { x: -1920, y: -40 },
    );
    expect(position).toEqual({ x: -1600 - 275, y: 82 });
  });

  it("clamps against a work-area origin on a monitor left of the primary", () => {
    // The origin is negative there, so a clamp that assumed `0` would leave the
    // bar above the visible area of that monitor and the window unreachable by
    // its own drag region.
    const position = restoredPosition(
      { fractionX: 0.5, offsetY: 20 },
      restored,
      { x: -1600, y: -90 },
      { x: -1920, y: -60 },
    );
    // -90 - 20 is above the work area's -60, so the clamp lifts it to -60.
    expect(position).toEqual({ x: -1600 - 550, y: -60 });
  });

  it("never places the bar above the top of the work area", () => {
    // A grab low on the bar with the pointer near the top of the screen would
    // otherwise put the bar off-screen, leaving the window unreachable by its
    // own drag region.
    const position = restoredPosition(
      { fractionX: 0.5, offsetY: 39 },
      restored,
      { x: 500, y: 10 },
      { x: 0, y: 0 },
    );
    expect(position.y).toBe(0);
  });

  it("keeps a horizontal position that the pointer has moved past the work area", () => {
    // Only the top is clamped. Clamping the left edge too would fight the OS
    // move loop, which is already following the pointer across monitors.
    const position = restoredPosition(
      grab,
      restored,
      { x: -400, y: 300 },
      { x: 0, y: 0 },
    );
    expect(position.x).toBe(-400 - 275);
  });
});
