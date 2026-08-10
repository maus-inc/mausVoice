import { describe, expect, it } from "vitest";
import {
  getNextPillVisibility,
  getPillMenuLabel,
} from "./tray-pill-visibility.utils";

describe("getNextPillVisibility", () => {
  it("reveals the pill from hidden", () => {
    expect(getNextPillVisibility("hidden")).toBe("persistent");
  });

  it("hides the pill from either visible state", () => {
    expect(getNextPillVisibility("persistent")).toBe("hidden");
    expect(getNextPillVisibility("while_active")).toBe("hidden");
  });

  it("treats invalid and missing values as visible, so the action hides", () => {
    // getEffectivePillVisibility normalizes anything unrecognised to
    // "persistent", so the offered action is to hide.
    expect(getNextPillVisibility("bogus")).toBe("hidden");
    expect(getNextPillVisibility("")).toBe("hidden");
    expect(getNextPillVisibility(null)).toBe("hidden");
    expect(getNextPillVisibility(undefined)).toBe("hidden");
  });

  it("alternates on repeated application", () => {
    const first = getNextPillVisibility("persistent");
    expect(first).toBe("hidden");
    expect(getNextPillVisibility(first)).toBe("persistent");
  });

  it("does not round-trip while_active, by design", () => {
    // One control cannot preserve a three-valued preference; showing again
    // lands on persistent.
    const hidden = getNextPillVisibility("while_active");
    expect(hidden).toBe("hidden");
    expect(getNextPillVisibility(hidden)).toBe("persistent");
  });
});

describe("getPillMenuLabel", () => {
  it("offers to show when hidden", () => {
    expect(getPillMenuLabel("hidden")).toBe("Show Pill");
  });

  it("offers to hide when visible", () => {
    expect(getPillMenuLabel("persistent")).toBe("Hide Pill");
    expect(getPillMenuLabel("while_active")).toBe("Hide Pill");
  });

  it("falls back to hide for invalid and missing values", () => {
    expect(getPillMenuLabel("bogus")).toBe("Hide Pill");
    expect(getPillMenuLabel(null)).toBe("Hide Pill");
    expect(getPillMenuLabel(undefined)).toBe("Hide Pill");
  });

  it("always labels the action that the next click performs", () => {
    // The label and the transition must never disagree.
    for (const state of ["hidden", "persistent", "while_active", "bogus"]) {
      const next = getNextPillVisibility(state);
      const label = getPillMenuLabel(state);
      expect(label).toBe(next === "hidden" ? "Hide Pill" : "Show Pill");
    }
  });
});
