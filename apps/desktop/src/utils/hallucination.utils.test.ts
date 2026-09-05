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

  it("leaves cloud hallucinations alone for sentinels and non-English", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Subtitles by the Amara.org community.",
        "primary",
      ),
    ).toBe("Subtitles by the Amara.org community.");
    expect(
      filterKnownSilenceHallucinations("Thank you for watching.", "auto"),
    ).toBe("Thank you for watching.");
  });

  it("leaves cloud hallucinations alone for non-English dictation", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Subtitles by the Amara.org community.",
        "de",
      ),
    ).toBe("Subtitles by the Amara.org community.");
  });

  it("does not collapse blank lines or indentation when nothing is filtered", () => {
    expect(filterKnownSilenceHallucinations("Hello\n\n  indented")).toBe(
      "Hello\n\n  indented",
    );
  });

  it("preserves paragraph breaks around a stripped hallucination line", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Ship the fix today.\nThank you for watching.\nNext paragraph.",
      ),
    ).toBe("Ship the fix today.\nNext paragraph.");
  });

  it("keeps a standalone genuine sign-off without an Amara credit", () => {
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
    expect(applyHallucinationFiltering(raw, segments, "en", false)).toBe(raw);
  });

  it("drops high noSpeechProb segments for non-English and auto languages", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [
      { text: "Some speech.", noSpeechProb: 0.1 },
      { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "de", true)).toBe(
      "Some speech.",
    );
    expect(applyHallucinationFiltering(raw, segments, "auto", true)).toBe(
      "Some speech.",
    );
  });

  it("keeps the English phrase filter off for auto while probability gating stays on", () => {
    const raw = "Thank you for watching. Useful speech.";
    const segments = [
      { text: "Thank you for watching.", noSpeechProb: 0.1 },
      { text: "Useful speech.", noSpeechProb: 0.1 },
      { text: "model noise", noSpeechProb: 0.95 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "auto", true)).toBe(
      "Thank you for watching. Useful speech.",
    );
  });

  it("drops near-certain-silence segments when the filter is enabled", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [
      { text: "Some speech.", noSpeechProb: 0.1 },
      { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "en", true)).toBe(
      "Some speech.",
    );
  });

  it("preserves leading-space segment boundaries when dropping silence", () => {
    const raw = "Hello world today";
    const segments = [
      { text: "Hello", noSpeechProb: 0.1 },
      { text: " world", noSpeechProb: 0.99 },
      { text: " today", noSpeechProb: 0.1 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "en", true)).toBe(
      "Hello today",
    );
  });

  it("joins segments without boundary whitespace when dropping silence", () => {
    const raw = "Hello world today";
    const segments = [
      { text: "Hello", noSpeechProb: 0.1 },
      { text: "world", noSpeechProb: 0.99 },
      { text: "today", noSpeechProb: 0.1 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "en", true)).toBe(
      "Hello today",
    );
  });

  it("inserts a space only where mixed kept segments lack a boundary", () => {
    const raw = "Hello world today";
    const segments = [
      { text: "Hello", noSpeechProb: 0.1 },
      { text: "noise", noSpeechProb: 0.99 },
      { text: "world", noSpeechProb: 0.1 },
      { text: " today", noSpeechProb: 0.1 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "en", true)).toBe(
      "Hello world today",
    );
  });

  it("keeps a genuine standalone Best regards. sign-off under the filter", () => {
    const raw = "Please review the doc. Best regards.";
    expect(applyHallucinationFiltering(raw, undefined, "en", true)).toBe(
      "Please review the doc. Best regards.",
    );
  });
});
