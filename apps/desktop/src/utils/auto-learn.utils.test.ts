import { describe, expect, it } from "vitest";
import { extractAutoLearnTerms } from "./auto-learn.utils";

const learn = (
  original: string,
  corrected: string,
  existingTerms: string[] = [],
): string[] =>
  extractAutoLearnTerms({ original, corrected, existingTerms }).learnedTerms;

describe("extractAutoLearnTerms", () => {
  it("learns a corrected proper noun", () => {
    expect(
      learn("my wife's name is Sonia", "my wife's name is Soniya"),
    ).toEqual(["Soniya"]);
  });

  it("does not learn the mistaken spelling that was replaced", () => {
    expect(
      learn("my wife's name is Sonia", "my wife's name is Soniya"),
    ).not.toContain("Sonia");
  });

  it("learns multiple corrected names at once", () => {
    expect(
      learn("I spoke to Sonia and Ralph", "I spoke to Soniya and Ralf"),
    ).toEqual(["Soniya", "Ralf"]);
  });

  it("strips trailing punctuation before comparing", () => {
    expect(learn("name is Sonia.", "name is Soniya.")).toEqual(["Soniya"]);
  });

  it("keeps internal apostrophes so possessives still match", () => {
    expect(learn("Sonia's book", "Soniya's book")).toEqual(["Soniya"]);
  });

  it("does not learn a common word correction", () => {
    expect(learn("the cat sat", "the dog sat")).toEqual([]);
  });

  it("does not learn a capitalized function word", () => {
    expect(learn("cat sat down", "The cat sat down")).toEqual([]);
  });

  it("does not learn lowercase words, even specialist ones", () => {
    expect(learn("I saw a quokkaz", "I saw a quokka")).toEqual([]);
  });

  it("does not learn a correction of an ordinary word", () => {
    expect(learn("I said teh", "I said the")).toEqual([]);
  });

  it("does not learn terms already in the dictionary (case-insensitive)", () => {
    expect(learn("name is Sonia", "name is Soniya", ["Soniya"])).toEqual([]);
  });

  it("deduplicates repeated new tokens", () => {
    expect(learn("Sonia and Sonia", "Soniya and Soniya")).toEqual(["Soniya"]);
  });

  it("learns nothing when the text is unchanged", () => {
    expect(learn("hello world", "hello world")).toEqual([]);
  });

  it("learns nothing when the edit is a rewrite", () => {
    const original = "the quick brown fox jumps over the lazy dog";
    const corrected =
      "Completely Different Sentence With Many New Words Here Today";
    expect(learn(original, corrected)).toEqual([]);
  });

  it("caps the number of learned terms", () => {
    const corrected = "Alpha Bravo Charlie Delta Echo Foxtrot Golf";
    expect(learn("a b c d e f g", corrected).length).toBeLessThanOrEqual(5);
  });

  it("treats numbers as non-letters and skips them", () => {
    expect(learn("I have 3", "I have 4")).toEqual([]);
  });

  it("ignores surrounding punctuation on both sides", () => {
    expect(learn("(Sonia)", "(Soniya)")).toEqual(["Soniya"]);
  });

  it("learns two-letter proper nouns but drops single letters", () => {
    expect(learn("her name is Jo", "her name is Bo")).toEqual(["Bo"]);
    expect(learn("I said A", "I said B")).toEqual([]);
  });
});
