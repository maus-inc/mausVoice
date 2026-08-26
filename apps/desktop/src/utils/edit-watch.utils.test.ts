import { describe, expect, it } from "vitest";
import { findEditCorrections } from "./edit-watch.utils";

const find = (
  insertedText: string,
  fieldText: string,
  existingTerms: string[] = [],
): string[] => findEditCorrections({ insertedText, fieldText, existingTerms });

describe("findEditCorrections", () => {
  it("detects a single-word proper-noun correction", () => {
    expect(find("theory", "Three")).toEqual(["Three"]);
  });

  it("detects a name correction inside a sentence", () => {
    expect(find("my wife's name is Sonia", "my wife's name is Soniya")).toEqual(
      ["Soniya"],
    );
  });

  it("locates the corrected word when surrounded by other document text", () => {
    expect(
      find(
        "name is Sonia",
        "Hello there my name is Soniya and some more words after",
      ),
    ).toEqual(["Soniya"]);
  });

  it("returns nothing when the text is unchanged", () => {
    expect(find("hello world", "hello world")).toEqual([]);
  });

  it("returns nothing for a lowercase word correction", () => {
    expect(find("I said teh", "I said the")).toEqual([]);
  });

  it("returns nothing for a pure insertion (nothing replaced)", () => {
    expect(find("hello", "hello Soniya")).toEqual([]);
  });

  it("skips terms already in the dictionary", () => {
    expect(find("Sonia", "Soniya", ["Soniya"])).toEqual([]);
  });

  it("returns nothing for a rewrite", () => {
    expect(
      find(
        "the quick brown fox jumps over the lazy dog",
        "Completely Different Sentence With Many New Words Here",
      ),
    ).toEqual([]);
  });

  it("returns nothing when the focused field is unrelated", () => {
    expect(
      find("my wife's name is Sonia", "Totally Unrelated Text Here Today"),
    ).toEqual([]);
  });

  it("rejects a single-word dictation against an unrelated focused word", () => {
    expect(find("hello", "Bo")).toEqual([]);
  });

  it("accepts a single-word full replacement that shares its initial letter", () => {
    expect(find("sandra", "Sarah")).toEqual(["Sarah"]);
  });

  it("returns nothing when the focused field is empty", () => {
    expect(find("hello world", "")).toEqual([]);
  });

  it("handles a correction at the very end of a long field", () => {
    expect(
      find("call Ralph", "first some earlier text then please call Ralf now"),
    ).toEqual(["Ralf"]);
  });
});
