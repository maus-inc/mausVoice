import { describe, expect, it } from "vitest";
import {
  filterKnownSilenceHallucinations,
  isKnownSilenceHallucination,
  isNearSilentAudio,
} from "./hallucination.utils";

describe("silence hallucination filtering", () => {
  it("recognizes common silence-only output", () => {
    expect(isKnownSilenceHallucination(" Thank you for watching. ")).toBe(true);
    expect(filterKnownSilenceHallucinations("[BLANK_AUDIO]")).toBe("");
  });

  it("does not remove a phrase embedded in real speech", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Thank you for watching the demo, and please send feedback.",
      ),
    ).toContain("Thank you for watching the demo");
  });

  it("detects near-silent samples by RMS", () => {
    expect(isNearSilentAudio(new Float32Array([0, 0, 0]))).toBe(true);
    expect(isNearSilentAudio(new Float32Array([0.2, -0.2, 0.1]))).toBe(false);
  });
});
