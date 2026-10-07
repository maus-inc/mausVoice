// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  computeSquareCrop,
  MAX_AVATAR_SOURCE_BYTES,
  validateAvatarFile,
} from "./avatar.utils";

/**
 * The avatar pipeline decides what a chosen file becomes before it is stored.
 * The encode step needs a real canvas, so it is exercised in the browser pass;
 * what is pinned here is the pair of decisions that silently produce a wrong
 * image when they are wrong: which crop is taken, and which files are refused.
 */
describe("computeSquareCrop", () => {
  it("takes the centre square of a landscape photo", () => {
    expect(computeSquareCrop(1200, 800)).toEqual({
      x: 200,
      y: 0,
      side: 800,
    });
  });

  it("takes the centre square of a portrait photo", () => {
    expect(computeSquareCrop(800, 1200)).toEqual({
      x: 0,
      y: 200,
      side: 800,
    });
  });

  it("leaves a square image alone", () => {
    expect(computeSquareCrop(512, 512)).toEqual({ x: 0, y: 0, side: 512 });
  });

  it("never crops outside the image", () => {
    for (const [width, height] of [
      [1, 9000],
      [9000, 1],
      [3, 3],
      [640, 480],
    ]) {
      const { x, y, side } = computeSquareCrop(width, height);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + side).toBeLessThanOrEqual(width);
      expect(y + side).toBeLessThanOrEqual(height);
    }
  });
});

describe("validateAvatarFile", () => {
  it("accepts the three formats the picker offers", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateAvatarFile({ type, size: 1000 })).toBeNull();
    }
  });

  it("refuses a file that is not an image", () => {
    expect(validateAvatarFile({ type: "application/pdf", size: 1000 })).toBe(
      "unsupported-type",
    );
    expect(validateAvatarFile({ type: "", size: 1000 })).toBe(
      "unsupported-type",
    );
  });

  it("refuses an image over the size limit and keeps the boundary", () => {
    expect(
      validateAvatarFile({ type: "image/png", size: MAX_AVATAR_SOURCE_BYTES }),
    ).toBeNull();
    expect(
      validateAvatarFile({
        type: "image/png",
        size: MAX_AVATAR_SOURCE_BYTES + 1,
      }),
    ).toBe("too-large");
  });

  it("reports the type before the size, because it is the fixable one", () => {
    expect(
      validateAvatarFile({
        type: "video/mp4",
        size: MAX_AVATAR_SOURCE_BYTES * 4,
      }),
    ).toBe("unsupported-type");
  });
});
