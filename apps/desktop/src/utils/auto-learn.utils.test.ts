import { describe, expect, it } from "vitest";
import {
  extractAutoLearnTerms,
  tokenizeForComparison,
} from "./auto-learn.utils";

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

  it("learns a casing-only correction (the word exists, capitalization changed)", () => {
    // The STT engine wrote the right letters but lowercase; the user's
    // capital is the proper-noun signal. A case-insensitive diff made this
    // correction invisible and the feature never learned anything.
    expect(learn("i work at google", "i work at Google")).toEqual(["Google"]);
    expect(learn("the apple is red", "the Apple is red")).toEqual(["Apple"]);
  });

  it("does not learn a casing-only de-capitalization", () => {
    // Lowercasing a word is not a proper-noun signal.
    expect(learn("I work at Google", "I work at google")).toEqual([]);
  });

  it("learns a corrected name that starts with a supplementary-plane letter", () => {
    expect(learn("my friend Unicode", "my friend \u{1D518}nicode")).toEqual([
      "\u{1D518}nicode",
    ]);
  });

  it("learns a case-only correction of a proper noun", () => {
    expect(
      learn("i spoke to sonia yesterday", "i spoke to Sonia yesterday"),
    ).toEqual(["Sonia"]);
  });

  it("learns a case-only acronym correction", () => {
    expect(learn("the nasa launch", "the NASA launch")).toEqual(["NASA"]);
  });

  it("learns each part of a case-only full-name correction", () => {
    expect(learn("kanye west", "Kanye West")).toEqual(["Kanye", "West"]);
  });

  it("does not learn a decapitalization", () => {
    expect(learn("Sonia is here", "sonia is here")).toEqual([]);
  });

  it("learns the corrected casing of a repeated token only once", () => {
    expect(learn("sonia and sonia", "Sonia and Sonia")).toEqual(["Sonia"]);
  });

  it("does not learn common words that only gained a capital", () => {
    expect(
      learn("wir trafen die neue kollegin", "Wir trafen die neue Kollegin"),
    ).toEqual(["Kollegin"]);
  });

  it("does not learn weekday or politeness insertions", () => {
    expect(learn("lets meet", "Lets meet Monday")).toEqual([]);
    expect(learn("send me the report", "Please send me the report")).toEqual(
      [],
    );
  });

  it("does not learn frequent German nouns but keeps real names", () => {
    expect(
      learn("wir haben die besucht", "Wir haben die Stadt Frankfurt besucht"),
    ).toEqual(["Frankfurt"]);
  });
});

describe("tokenizeForComparison", () => {
  it("strips surrounding punctuation but keeps apostrophes and hyphens", () => {
    expect(tokenizeForComparison("(hello), well-known [word]")).toEqual([
      "hello",
      "well-known",
      "word",
    ]);
  });

  it("drops tokens that carry no apostrophe or hyphen and no letters", () => {
    expect(tokenizeForComparison("!!! ... ???")).toEqual([]);
  });

  it("removes a trailing possessive", () => {
    expect(tokenizeForComparison("Sonia's car")).toEqual(["Sonia", "car"]);
  });

  it("keeps supplementary-plane letters whole at both edges", () => {
    expect(tokenizeForComparison("\u{1D518}nicode")).toEqual([
      "\u{1D518}nicode",
    ]);
    expect(tokenizeForComparison("Nicode\u{1D518}")).toEqual([
      "Nicode\u{1D518}",
    ]);
    expect(tokenizeForComparison("(\u{1D518}nicode)")).toEqual([
      "\u{1D518}nicode",
    ]);
    expect(tokenizeForComparison("\u{1D518}")).toEqual(["\u{1D518}"]);
  });

  it("trims long punctuation runs in linear time", () => {
    const token = `${"!".repeat(5000)}word${"?".repeat(5000)}`;
    const start = performance.now();

    expect(tokenizeForComparison(token)).toEqual(["word"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
