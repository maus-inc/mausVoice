import { describe, expect, it } from "vitest";
import { clampPlaybackProgress, formatDuration } from "./audio-playback.utils";

describe("clampPlaybackProgress", () => {
  it("clamps below 0 and above 1", () => {
    expect(clampPlaybackProgress(-0.2)).toBe(0);
    expect(clampPlaybackProgress(1.4)).toBe(1);
    expect(clampPlaybackProgress(0.33)).toBe(0.33);
  });
});

describe("formatDuration", () => {
  it("formats finite milliseconds", () => {
    expect(formatDuration(65000)).toBe("1:05");
  });

  it("returns 0:00 for missing values", () => {
    expect(formatDuration(null)).toBe("0:00");
    expect(formatDuration(undefined)).toBe("0:00");
  });
});
