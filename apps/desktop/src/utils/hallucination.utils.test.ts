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

  it("strips the cloud subtitle credit and its fabricated sign-off", () => {
    expect(
      filterKnownSilenceHallucinations("Subtitles by the Amara.org community"),
    ).toBe("");
    expect(
      filterKnownSilenceHallucinations("Subtitles by the Amara.org community."),
    ).toBe("");
    expect(
      filterKnownSilenceHallucinations(
        "Ship the fix today. Subtitles by the Amara.org community.\nBest regards.",
      ),
    ).toBe("Ship the fix today.");
  });

  it("keeps a sign-off that is part of a real sentence", () => {
    expect(filterKnownSilenceHallucinations("Best regards, Alice")).toBe(
      "Best regards, Alice",
    );
    expect(
      filterKnownSilenceHallucinations("Send my best regards to the team."),
    ).toBe("Send my best regards to the team.");
  });

  it("leaves cloud hallucinations alone for non-English dictation", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Subtitles by the Amara.org community.",
        "de",
      ),
    ).toBe("Subtitles by the Amara.org community.");
  });
});
