import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANDS_FREE_DELAY_MS,
  getEffectiveHandsFreeDelayMs,
  isHandsFreeDelayEnabled,
  MAX_HANDS_FREE_DELAY_MS,
  normalizeHandsFreeDelayMs,
} from "./hands-free-delay.utils";

describe("normalizeHandsFreeDelayMs", () => {
  it("returns the default when the value is missing or invalid", () => {
    expect(normalizeHandsFreeDelayMs(undefined)).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
    expect(normalizeHandsFreeDelayMs(null)).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
    expect(normalizeHandsFreeDelayMs(Number.NaN)).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
  });

  it("clamps negative values to zero and caps excessive values", () => {
    expect(normalizeHandsFreeDelayMs(-50)).toBe(0);
    expect(normalizeHandsFreeDelayMs(MAX_HANDS_FREE_DELAY_MS + 5_000)).toBe(
      MAX_HANDS_FREE_DELAY_MS,
    );
  });

  it("rounds decimals down", () => {
    expect(normalizeHandsFreeDelayMs(750.9)).toBe(750);
  });

  it("preserves a value of 0 (disabled)", () => {
    expect(normalizeHandsFreeDelayMs(0)).toBe(0);
  });

  it("preserves an in-range value", () => {
    expect(normalizeHandsFreeDelayMs(1_500)).toBe(1_500);
  });
});

describe("isHandsFreeDelayEnabled", () => {
  it("is disabled for null, undefined, and zero", () => {
    expect(isHandsFreeDelayEnabled(null)).toBe(false);
    expect(isHandsFreeDelayEnabled(undefined)).toBe(false);
    expect(isHandsFreeDelayEnabled(0)).toBe(false);
  });

  it("is enabled for any positive value", () => {
    expect(isHandsFreeDelayEnabled(1)).toBe(true);
    expect(isHandsFreeDelayEnabled(MAX_HANDS_FREE_DELAY_MS)).toBe(true);
  });

  it("is disabled for non-finite values", () => {
    expect(isHandsFreeDelayEnabled(Number.NaN)).toBe(false);
  });
});

describe("getEffectiveHandsFreeDelayMs", () => {
  it("returns the stored preference when present", () => {
    expect(getEffectiveHandsFreeDelayMs({ handsFreeDelayMs: 800 })).toBe(800);
  });

  it("falls back to the default when preferences are missing or unset", () => {
    expect(getEffectiveHandsFreeDelayMs(null)).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
    expect(getEffectiveHandsFreeDelayMs({})).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
    expect(getEffectiveHandsFreeDelayMs({ handsFreeDelayMs: null })).toBe(
      DEFAULT_HANDS_FREE_DELAY_MS,
    );
  });

  it("preserves a null value (disabled) when explicitly set", () => {
    expect(getEffectiveHandsFreeDelayMs({ handsFreeDelayMs: null })).toBe(0);
  });
});
