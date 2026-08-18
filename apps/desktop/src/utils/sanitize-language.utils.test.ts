import { describe, expect, it } from "vitest";
import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";

describe("isEnglishSanitizeLanguage", () => {
  it("treats omitted language as English for legacy callers", () => {
    expect(isEnglishSanitizeLanguage(undefined)).toBe(true);
  });

  it("accepts en and regional English", () => {
    expect(isEnglishSanitizeLanguage("en")).toBe(true);
    expect(isEnglishSanitizeLanguage("en-GB")).toBe(true);
    expect(isEnglishSanitizeLanguage("English")).toBe(true);
  });

  it("rejects sentinels and other languages", () => {
    expect(isEnglishSanitizeLanguage("primary")).toBe(false);
    expect(isEnglishSanitizeLanguage("auto")).toBe(false);
    expect(isEnglishSanitizeLanguage("de")).toBe(false);
    expect(isEnglishSanitizeLanguage("fr")).toBe(false);
  });
});
