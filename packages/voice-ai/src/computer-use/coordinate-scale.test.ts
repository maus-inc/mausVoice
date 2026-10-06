import { describe, expect, it } from "vitest";
import {
  clampToDisplay,
  denormalizeGridCoordinate,
  NORMALIZED_GRID_SIZE,
  scaleCaptureCoordinate,
} from "./coordinate-scale";

describe("clampToDisplay", () => {
  it("rounds to the nearest pixel", () => {
    expect(clampToDisplay(10.4, 100)).toBe(10);
    expect(clampToDisplay(10.5, 100)).toBe(11);
    expect(clampToDisplay(10.6, 100)).toBe(11);
  });

  it("keeps a point at the far corner on the display", () => {
    // The top right pixel of a 100 wide display is 99. A clamp to `extent`
    // instead of `extent - 1` puts the corner one pixel past the edge, which is
    // where a click silently does nothing.
    expect(clampToDisplay(100, 100)).toBe(99);
  });

  it("never returns a negative pixel", () => {
    expect(clampToDisplay(-1, 100)).toBe(0);
    expect(clampToDisplay(-9999, 100)).toBe(0);
  });
});

describe("denormalizeGridCoordinate", () => {
  it("puts the grid's zero at the display's zero", () => {
    expect(denormalizeGridCoordinate(0, 1920)).toBe(0);
  });

  it("puts the grid's far corner inside the display", () => {
    // The grid's last addressable point is one step below its far edge.
    expect(denormalizeGridCoordinate(NORMALIZED_GRID_SIZE - 1, 1920)).toBe(1918);
  });

  it("scales the same point differently on two displays", () => {
    expect(denormalizeGridCoordinate(500, 1000)).toBe(500);
    expect(denormalizeGridCoordinate(500, 2000)).toBe(1000);
  });

  it("clamps a point beyond the grid rather than overshooting", () => {
    expect(denormalizeGridCoordinate(5000, 1000)).toBe(999);
  });
});

describe("scaleCaptureCoordinate", () => {
  it("leaves a coordinate alone when the capture is the display's size", () => {
    expect(scaleCaptureCoordinate(640, 1920, 1920)).toBe(640);
  });

  it("scales a coordinate out of a downscaled capture onto the display", () => {
    // Halfway across a 1280 wide capture is halfway across a 1920 wide display,
    // which is 960. Reading 640 as a screen pixel would click a third of the
    // way in instead.
    expect(scaleCaptureCoordinate(640, 1280, 1920)).toBe(960);
  });

  it("scales the vertical axis independently of the horizontal", () => {
    expect(scaleCaptureCoordinate(360, 720, 1080)).toBe(540);
  });

  it("clamps a coordinate at the capture's corner onto the display", () => {
    expect(scaleCaptureCoordinate(1280, 1280, 1920)).toBe(1919);
  });
});