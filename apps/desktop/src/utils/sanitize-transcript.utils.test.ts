import { describe, expect, it } from "vitest";
import { sanitizeTranscriptText } from "./sanitize-transcript.utils";

describe("sanitizeTranscriptText", () => {
  it("applies replacements before spoken commands", () => {
    expect(
      sanitizeTranscriptText({
        rawTranscript: "hello comma world",
        replacementRules: [{ sourceValue: "comma", destinationValue: "PAUSE" }],
      }),
    ).toBe("hello PAUSE world");
  });

  it("runs spoken commands then hashtag conversion", () => {
    expect(
      sanitizeTranscriptText({
        rawTranscript: "hashtag ship new line thanks",
        replacementRules: [],
      }),
    ).toBe("#ship\nthanks");
  });

  it("strips a silence hallucination after commands", () => {
    expect(
      sanitizeTranscriptText({
        rawTranscript: "Thank you for watching.",
        replacementRules: [],
        language: "en",
      }),
    ).toBe("");
  });

  it("can disable spoken commands without disabling the filter", () => {
    expect(
      sanitizeTranscriptText({
        rawTranscript: "hello new line world",
        replacementRules: [],
        spokenCommandsEnabled: false,
      }),
    ).toBe("hello new line world");
  });

  it("can disable the hallucination filter", () => {
    expect(
      sanitizeTranscriptText({
        rawTranscript: "Thank you for watching.",
        replacementRules: [],
        language: "en",
        hallucinationFilterEnabled: false,
      }),
    ).toBe("Thank you for watching.");
  });
});
