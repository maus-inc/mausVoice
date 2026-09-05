import { describe, expect, it } from "vitest";
import {
  codePointOf,
  countWords,
  isLogBreakingControl,
  isLogBreakingControlCode,
} from "./string";

describe("countWords", () => {
  it("should count words in a normal sentence", () => {
    expect(countWords("Hello world")).toBe(2);
  });

  it("should count words with multiple spaces", () => {
    expect(countWords("Hello    world   test")).toBe(3);
  });

  it("should handle empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("should handle string with only spaces", () => {
    expect(countWords("   ")).toBe(0);
  });

  it("should count single word", () => {
    expect(countWords("Hello")).toBe(1);
  });

  it("should handle string with leading and trailing spaces", () => {
    expect(countWords("  Hello world  ")).toBe(2);
  });

  it("should handle string with tabs and newlines", () => {
    expect(countWords("Hello\tworld\ntest")).toBe(3);
  });

  it("should count words in a longer sentence", () => {
    expect(countWords("The quick brown fox jumps over the lazy dog")).toBe(9);
  });

  it("should count long words as multiple words", () => {
    const twoHundredChars = "a".repeat(200);
    expect(countWords(twoHundredChars)).toBe(2);
    expect(countWords("Short " + twoHundredChars)).toBe(3);
  });
});

describe("codePointOf", () => {
  it("returns 0 for an empty string", () => {
    expect(codePointOf("")).toBe(0);
  });

  it("returns the BMP code point", () => {
    expect(codePointOf("A")).toBe(0x41);
  });

  it("returns the full non-BMP code point, not a surrogate unit", () => {
    // U+1F600 😀 is outside the BMP; charCodeAt would yield 0xd83d.
    expect(codePointOf("\u{1F600}")).toBe(0x1f600);
  });
});

describe("isLogBreakingControl", () => {
  it("flags C0, DEL, and C1 codes", () => {
    expect(isLogBreakingControlCode(0x0a)).toBe(true);
    expect(isLogBreakingControlCode(0x7f)).toBe(true);
    expect(isLogBreakingControlCode(0x85)).toBe(true);
    expect(isLogBreakingControlCode(0x41)).toBe(false);
  });

  it("inspects the first code point of a string", () => {
    expect(isLogBreakingControl(String.fromCodePoint(0x0a))).toBe(true);
    expect(isLogBreakingControl("A")).toBe(false);
    expect(isLogBreakingControl("")).toBe(false);
  });
});
