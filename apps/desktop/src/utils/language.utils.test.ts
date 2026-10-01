import { describe, expect, it } from "vitest";
import {
  AUTO_LANGUAGE,
  KEYBOARD_LAYOUT_LANGUAGE,
  ORDERED_DICTATION_LANGUAGES,
  toSelectableDictationLanguage,
} from "./language.utils";

// A stored preference and the detected system locale are both locale-shaped, and
// a Select whose value is not one of its own options renders blank while the
// form still submits it, so what these return has to be a code the Select offers.
describe("toSelectableDictationLanguage", () => {
  it("keeps a code the catalogue already has", () => {
    expect(toSelectableDictationLanguage("en")).toBe("en");
    expect(toSelectableDictationLanguage("zh-TW")).toBe("zh-TW");
    expect(toSelectableDictationLanguage("pt-BR")).toBe("pt-BR");
    expect(toSelectableDictationLanguage(AUTO_LANGUAGE)).toBe(AUTO_LANGUAGE);
  });

  it("narrows a locale to a supported base language", () => {
    expect(toSelectableDictationLanguage("en-US")).toBe("en");
    expect(toSelectableDictationLanguage("fr-CA")).toBe("fr");
  });

  it("shows keyboard layout as auto-detect, since it is not a language", () => {
    expect(toSelectableDictationLanguage(KEYBOARD_LAYOUT_LANGUAGE)).toBe(
      AUTO_LANGUAGE,
    );
  });

  it("falls back to auto-detect for a language it cannot narrow", () => {
    expect(toSelectableDictationLanguage("xx")).toBe(AUTO_LANGUAGE);
    expect(toSelectableDictationLanguage("")).toBe(AUTO_LANGUAGE);
    expect(toSelectableDictationLanguage("qq-ZZ")).toBe(AUTO_LANGUAGE);
  });

  it("only ever returns a value the language Select offers", () => {
    const offered = new Set<string>([
      AUTO_LANGUAGE,
      ...ORDERED_DICTATION_LANGUAGES,
    ]);
    for (const language of [
      "en",
      "en-US",
      "zh-TW",
      "fr-CA",
      KEYBOARD_LAYOUT_LANGUAGE,
      "xx",
      "",
    ]) {
      expect(offered).toContain(toSelectableDictationLanguage(language));
    }
  });
});
