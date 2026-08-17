import { describe, expect, it } from "vitest";
import {
  applyHallucinationFiltering,
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

  it("keeps a standalone genuine sign-off without an Amara credit", () => {
    // "Best regards." is no longer a global hallucination, so a real dictated
    // email ending with it must survive when there is no subtitle/Amara phrase.
    expect(
      filterKnownSilenceHallucinations("Please review the doc. Best regards."),
    ).toBe("Please review the doc. Best regards.");
    expect(filterKnownSilenceHallucinations("Best regards.")).toBe(
      "Best regards.",
    );
  });
});

describe("applyHallucinationFiltering", () => {
  it("preserves the raw transcript exactly when the filter is disabled", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [{ text: "[BLANK_AUDIO]", noSpeechProb: 0.99 }];
    expect(
      applyHallucinationFiltering(raw, segments, "en", false),
    ).toBe(raw);
  });

  it("drops near-certain-silence segments when the filter is enabled", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [
      { text: "Some speech.", noSpeechProb: 0.1 },
      { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
    ];
    expect(
      applyHallucinationFiltering(raw, segments, "en", true),
    ).toBe("Some speech.");
  });

  it("keeps a genuine standalone Best regards. sign-off under the filter", () => {
    const raw = "Please review the doc. Best regards.";
    expect(
      applyHallucinationFiltering(raw, undefined, "en", true),
    ).toBe("Please review the doc. Best regards.");
  });
});
