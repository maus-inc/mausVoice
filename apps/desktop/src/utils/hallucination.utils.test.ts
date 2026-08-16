import { describe, expect, it } from "vitest";
import {
  filterKnownSilenceHallucinations,
  isKnownSilenceHallucination,
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

  it("preserves short genuine sentences that resemble old silence entries", () => {
    expect(filterKnownSilenceHallucinations("You.")).toBe("You.");
    expect(filterKnownSilenceHallucinations("The end.")).toBe("The end.");
  });
});
