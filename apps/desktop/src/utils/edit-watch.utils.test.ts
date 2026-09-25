import { describe, expect, it } from "vitest";
import {
  baselineHoldsDictation,
  findEditCorrections,
} from "./edit-watch.utils";

const find = ({
  insertedText,
  baselineText,
  fieldText,
  existingTerms = [],
}: {
  insertedText: string;
  baselineText: string;
  fieldText: string;
  existingTerms?: string[];
}): string[] =>
  findEditCorrections({ insertedText, baselineText, fieldText, existingTerms });

describe("baselineHoldsDictation", () => {
  it("accepts a field that contains the dictation among other text", () => {
    expect(
      baselineHoldsDictation(
        "call Ralph",
        "first some earlier text then please call Ralph now",
      ),
    ).toBe(true);
  });

  it("rejects a field that never received the dictation", () => {
    expect(
      baselineHoldsDictation(
        "my wife's name is Sonia",
        "Totally Unrelated Text Here Today",
      ),
    ).toBe(false);
  });

  it("ignores case, whitespace reflow and smart apostrophes", () => {
    expect(
      baselineHoldsDictation(
        "my wife's name is Sonia",
        "  My   wife’s   NAME   is   sonia. ",
      ),
    ).toBe(true);
  });

  it("rejects an empty dictation", () => {
    expect(baselineHoldsDictation("", "anything at all")).toBe(false);
  });
});

describe("findEditCorrections", () => {
  it("detects a single-word proper-noun correction", () => {
    expect(
      find({
        insertedText: "theory",
        baselineText: "theory",
        fieldText: "Three",
      }),
    ).toEqual(["Three"]);
  });

  it("detects a name correction inside a sentence", () => {
    expect(
      find({
        insertedText: "my wife's name is Sonia",
        baselineText: "my wife's name is Sonia",
        fieldText: "my wife's name is Soniya",
      }),
    ).toEqual(["Soniya"]);
  });

  it("detects a case-only correction of a lowercased proper noun", () => {
    expect(
      find({
        insertedText: "i spoke to sonia yesterday",
        baselineText: "i spoke to sonia yesterday",
        fieldText: "i spoke to Sonia yesterday",
      }),
    ).toEqual(["Sonia"]);
  });

  it("detects a case-only correction of a single-word dictation", () => {
    expect(
      find({
        insertedText: "sonia",
        baselineText: "sonia",
        fieldText: "Sonia",
      }),
    ).toEqual(["Sonia"]);
  });

  it("detects a correction inside a longer document", () => {
    expect(
      find({
        insertedText: "name is Sonia",
        baselineText: "Hello there my name is Sonia and some more words after",
        fieldText: "Hello there my name is Soniya and some more words after",
      }),
    ).toEqual(["Soniya"]);
  });

  it("detects a casing-only correction in the field", () => {
    // The user capitalized a word the STT engine had written lowercase;
    // the capital is the proper-noun signal. Case-insensitive diffing made
    // this correction invisible (added and removed were both empty).
    expect(
      find({
        insertedText: "i work at google",
        baselineText: "i work at google",
        fieldText: "i work at Google",
      }),
    ).toEqual(["Google"]);
  });

  it("handles a correction at the very end of a long field", () => {
    expect(
      find({
        insertedText: "call Ralph",
        baselineText: "first some earlier text then please call Ralph now",
        fieldText: "first some earlier text then please call Ralf now",
      }),
    ).toEqual(["Ralf"]);
  });

  it("returns nothing when the text is unchanged", () => {
    expect(
      find({
        insertedText: "hello world",
        baselineText: "hello world",
        fieldText: "hello world",
      }),
    ).toEqual([]);
  });

  it("returns nothing for a lowercase word correction", () => {
    expect(
      find({
        insertedText: "I said teh",
        baselineText: "I said teh",
        fieldText: "I said the",
      }),
    ).toEqual([]);
  });

  it("returns nothing for a pure insertion (nothing replaced)", () => {
    expect(
      find({
        insertedText: "hello",
        baselineText: "hello",
        fieldText: "hello Soniya",
      }),
    ).toEqual([]);
  });

  it("skips terms already in the dictionary", () => {
    expect(
      find({
        insertedText: "Sonia",
        baselineText: "Sonia",
        fieldText: "Soniya",
        existingTerms: ["Soniya"],
      }),
    ).toEqual([]);
  });

  it("returns nothing for a rewrite", () => {
    expect(
      find({
        insertedText: "the quick brown fox jumps over the lazy dog",
        baselineText: "the quick brown fox jumps over the lazy dog",
        fieldText: "Completely Different Sentence With Many New Words Here",
      }),
    ).toEqual([]);
  });

  it("returns nothing when the focused field is empty", () => {
    expect(
      find({
        insertedText: "hello world",
        baselineText: "hello world",
        fieldText: "",
      }),
    ).toEqual([]);
  });

  it("returns nothing when the dictation is empty", () => {
    expect(
      find({
        insertedText: "",
        baselineText: "hello world",
        fieldText: "hello Ralph",
      }),
    ).toEqual([]);
  });

  // Regressions: document text that was on screen before the dictation landed
  // used to be located as "the dictation region" and proposed as a correction.
  describe("pre-existing document text", () => {
    it("never proposes a word that was already in the field", () => {
      expect(
        find({
          insertedText: "send the report to Ralf today",
          baselineText:
            "Quarterly Report Mausvoice send the report to Ralf today",
          fieldText: "Quarterly Report Mausvoice send the report to Ralf today",
        }),
      ).toEqual([]);
    });

    it("proposes only the corrected word, not its capitalized neighbours", () => {
      expect(
        find({
          insertedText: "Ralf will call about the invoice",
          baselineText:
            "Mausvoice Quarterly update notes Ralf will call about the invoice",
          fieldText:
            "Mausvoice Quarterly update notes Raul will call about the invoice",
        }),
      ).toEqual(["Raul"]);
    });

    it("ignores unrelated capitalised text elsewhere in the field", () => {
      expect(
        find({
          insertedText: "meeting tomorrow at ten",
          baselineText: "Quarterly Review Board meeting tomorrow at ten",
          fieldText: "Quarterly Review Board meeting tomorrow at eleven",
        }),
      ).toEqual([]);
    });
  });
});
