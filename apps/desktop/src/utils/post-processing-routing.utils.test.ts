import { describe, expect, it } from "vitest";
import {
  SHORT_DICTATION_MAX_CHARS,
  isShortDictation,
  resolvePostProcessingRoute,
} from "./post-processing-routing.utils";

describe("isShortDictation", () => {
  it("accepts a word, a sentence and about two sentences", () => {
    for (const text of [
      "hello",
      "hey michael",
      "send the report by friday.",
      "Send the report by Friday. Do not copy anyone else.",
      "so um I need to like send the the report by uh friday no wait thursday",
    ]) {
      expect(isShortDictation(text)).toBe(true);
    }
  });

  it("rejects empty input", () => {
    expect(isShortDictation("")).toBe(false);
    expect(isShortDictation("   ")).toBe(false);
  });

  it("rejects a third sentence", () => {
    expect(
      isShortDictation("One thing. Two things. Three things are here."),
    ).toBe(false);
  });

  it("rejects input past the word or character bound", () => {
    const longWords = Array.from(
      { length: 31 },
      (_, index) => `word${index}`,
    ).join(" ");
    expect(isShortDictation(longWords)).toBe(false);

    // No spaces, so the word count cannot be the bound that catches it.
    const longUnspaced = "あ".repeat(SHORT_DICTATION_MAX_CHARS + 1);
    expect(isShortDictation(longUnspaced)).toBe(false);
  });
});

describe("resolvePostProcessingRoute", () => {
  it("routes a short dictation in a prose style to the local transforms", () => {
    for (const toneId of ["default", "chat", "concise", "formal", "prompt"]) {
      expect(
        resolvePostProcessingRoute({
          transcript: "send the report by friday",
          toneId,
          enabled: true,
          language: "en",
        }),
      ).toEqual({ route: "local", reason: "local-short-dictation" });
    }
  });

  it("keeps the structured styles on the provider", () => {
    for (const toneId of ["email", "bullets", "notes"]) {
      expect(
        resolvePostProcessingRoute({
          transcript: "send the report by friday",
          toneId,
          enabled: true,
          language: "en",
        }),
      ).toEqual({
        route: "api",
        reason: "api-tone-has-no-local-prose-transform",
      });
    }
  });

  it("keeps a custom or missing tone on the provider", () => {
    for (const toneId of [null, "custom-tone-id"]) {
      expect(
        resolvePostProcessingRoute({
          transcript: "send the report by friday",
          toneId,
          enabled: true,
          language: "en",
        }).route,
      ).toBe("api");
    }
  });

  it("routes everything to the provider when the preference is off", () => {
    expect(
      resolvePostProcessingRoute({
        transcript: "hello",
        toneId: "default",
        enabled: false,
        language: "en",
      }),
    ).toEqual({ route: "api", reason: "api-routing-disabled" });
  });

  it("keeps a non-English dictation on the provider", () => {
    for (const language of ["de", "fr-CA", "auto", "primary", ""]) {
      expect(
        resolvePostProcessingRoute({
          transcript: "send the report by friday",
          toneId: "default",
          enabled: true,
          language,
        }),
      ).toEqual({ route: "api", reason: "api-non-english-dictation" });
    }
  });

  it("routes an English dictation locally for a regional English code", () => {
    for (const language of ["en", "en-US", "EN"]) {
      expect(
        resolvePostProcessingRoute({
          transcript: "send the report by friday",
          toneId: "default",
          enabled: true,
          language,
        }).route,
      ).toBe("local");
    }
  });

  it("keeps a long dictation on the provider", () => {
    expect(
      resolvePostProcessingRoute({
        transcript:
          "This is a longer dictation. It has several sentences and a lot of words to clean up properly. It keeps going so that it is clearly past every bound, with one more sentence for good measure.",
        toneId: "default",
        enabled: true,
        language: "en",
      }),
    ).toEqual({ route: "api", reason: "api-dictation-not-short" });
  });
});
