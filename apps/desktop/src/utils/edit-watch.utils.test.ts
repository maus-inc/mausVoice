import { describe, expect, it, vi } from "vitest";
import {
  countDictationOccurrences,
  findEditCorrections,
} from "./edit-watch.utils";

const holds = (insertedText: string, fieldText: string): boolean =>
  countDictationOccurrences(insertedText, fieldText) > 0;

/** Comfortably past MAX_ALIGNED_TOKENS, which is 600. */
const OVERLONG_FILLER = "lorem ipsum dolor sit amet consectetur ".repeat(200);
const tokenCountOf = (text: string): number => text.trim().split(/\s+/).length;

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

describe("countDictationOccurrences as the containment gate", () => {
  it("accepts a field that contains the dictation among other text", () => {
    expect(
      holds("call Ralph", "first some earlier text then please call Ralph now"),
    ).toBe(true);
  });

  it("rejects a field that never received the dictation", () => {
    expect(
      holds("my wife's name is Sonia", "Totally Unrelated Text Here Today"),
    ).toBe(false);
  });

  it("ignores case, whitespace reflow and smart apostrophes", () => {
    expect(
      holds("my wife's name is Sonia", "  My   wife’s   NAME   is   sonia. "),
    ).toBe(true);
  });

  it("rejects an empty dictation", () => {
    expect(holds("", "anything at all")).toBe(false);
  });

  it("does not match across a character or token boundary", () => {
    // A character search reported all three of these as holding the
    // dictation, and a false positive here is not harmless: the snapshot
    // becomes the baseline and the next small edit in that unrelated field
    // turns into a proposed term.
    expect(holds("call Ralph", "recall ralphxyz")).toBe(false);
    expect(holds("Send invoice", "Please resend invoices tomorrow")).toBe(
      false,
    );
    expect(holds("Ralph", "Ralphson")).toBe(false);
  });
});

describe("countDictationOccurrences", () => {
  it("counts each run of the dictated text in a field", () => {
    expect(countDictationOccurrences("call Ralph", "call Ralph")).toBe(1);
    expect(
      countDictationOccurrences("call Ralph", "call Ralph call Ralph"),
    ).toBe(2);
    expect(countDictationOccurrences("call Ralph", "say call Ralph now")).toBe(
      1,
    );
    expect(countDictationOccurrences("call Ralph", "nothing here")).toBe(0);
    expect(countDictationOccurrences("", "call Ralph")).toBe(0);
  });

  it("keeps working in a field far longer than the alignment bound", () => {
    // The alignment is quadratic and is bounded at 600 tokens. Containment is a
    // linear scan for a fixed run, so bounding it too would switch the whole
    // feature off in a long email body or meeting-notes document, silently.
    const longField = `${OVERLONG_FILLER} call Ralph ${OVERLONG_FILLER}`;
    expect(tokenCountOf(longField)).toBeGreaterThan(600);
    expect(countDictationOccurrences("call Ralph", longField)).toBe(1);
  });

  it("reports a field too long to align instead of failing silently", () => {
    const onUnalignable = vi.fn();
    const learned = findEditCorrections({
      insertedText: "call Ralph",
      baselineText: `${OVERLONG_FILLER} call Ralph`,
      fieldText: `${OVERLONG_FILLER} call Ralf`,
      existingTerms: [],
      onUnalignable,
    });

    expect(learned).toEqual([]);
    expect(onUnalignable).toHaveBeenCalledOnce();
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

    it("never proposes a proper noun the user edited above the dictation", () => {
      // The user renamed a heading they never dictated. The whole-field diff
      // learned it; the dictation region does not contain it.
      expect(
        find({
          insertedText: "meeting tomorrow at ten",
          baselineText: "Quarterly Review Board meeting tomorrow at ten",
          fieldText: "Quarterly Review Committee meeting tomorrow at ten",
        }),
      ).toEqual([]);
    });

    it("still learns a dictation correction next to an unrelated edit", () => {
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "first some earlier text then please call Ralph now",
          fieldText: "first some earlier text please call Ralf now",
        }),
      ).toEqual(["Ralf"]);
    });

    it("never learns from a region the user replaced wholesale", () => {
      // Nothing around the dictation survived, so the region has no known edge
      // and the surrounding rewrite is not the dictation's business.
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "first some earlier text then please call Ralph now",
          fieldText: "Completely different opening words here call Ralf",
        }),
      ).toEqual([]);
    });

    it("never proposes a proper noun the user typed just before the dictation", () => {
      // The anchor below the dictation says where the field was when the
      // dictation landed, not where the dictation starts. Anything typed in
      // between used to be paired against the first dictated token, and the
      // prompt then offered the typed word instead of the correction.
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "alpha beta call Ralph",
          fieldText: "alpha beta Zeta call Ralf",
        }),
      ).toEqual(["Ralf"]);
    });

    it("still learns when a dictated word before the correction was deleted", () => {
      // The leading run is bounded from both sides, so deleting a dictated
      // token must not drag the text in front of it into the comparison.
      expect(
        find({
          insertedText: "beta call Ralph",
          baselineText: "alpha beta call Ralph",
          fieldText: "alpha call Ralf",
        }),
      ).toEqual(["Ralf"]);
    });
  });

  // The dictation is inserted as one block, so dicting the same text into the
  // same field twice leaves two copies. The correction belongs to the copy the
  // user touched, not to the first occurrence the diff happens to land on.
  describe("a dictation repeated in the same field", () => {
    it("learns a correction to the second copy", () => {
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "call Ralph call Ralph",
          fieldText: "call Ralph call Ralf",
        }),
      ).toEqual(["Ralf"]);
    });

    it("learns a correction to the first copy", () => {
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "call Ralph call Ralph",
          fieldText: "call Ralf call Ralph",
        }),
      ).toEqual(["Ralf"]);
    });

    it("proposes nothing when both copies are untouched", () => {
      expect(
        find({
          insertedText: "call Ralph",
          baselineText: "call Ralph call Ralph",
          fieldText: "call Ralph call Ralph",
        }),
      ).toEqual([]);
    });
  });
});
