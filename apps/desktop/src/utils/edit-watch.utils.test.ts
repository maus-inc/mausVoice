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

  // A dictation whose tokens repeat ("very very good") matches itself at
  // overlapping offsets, so the scan counts one run per matching offset rather
  // than per copy. That is deliberate: the count is a containment signal and a
  // paste-detection delta, never a tally of copies to subtract, and a copy is
  // only ever told apart by the count rising. Deduplicating overlapping runs
  // would make a self-overlapping dictation report the same count before and
  // after its own paste landed, so the baseline would stay on the pre-paste read
  // and the correction to the pasted copy would never be learned.
  describe("a dictation that matches itself at overlapping offsets", () => {
    it("still gates on containment rather than on the number of copies", () => {
      expect(holds("very very good", "some notes very very good here")).toBe(
        true,
      );
      expect(holds("very very good", "very good very good")).toBe(false);
    });

    it("counts the overlapping runs so a paste raises the count", () => {
      // "very very good" matches at offsets 0 and 1 of the pasted field.
      const beforePaste = countDictationOccurrences(
        "very very good",
        "notes very very good",
      );
      const afterPaste = countDictationOccurrences(
        "very very good",
        "notes very very good very very good",
      );

      expect(beforePaste).toBeGreaterThan(0);
      expect(afterPaste).toBeGreaterThan(beforePaste);
    });

    it("learns a correction to a self-overlapping dictation's only copy", () => {
      // The overlap must not make the pre-existing copy look like a paste, and
      // it must not stop the pasted copy from being compared. Only a proper
      // noun is learnable, so the correction capitalizes.
      expect(
        find({
          insertedText: "call Ralph very very good",
          baselineText: "call Ralph very very good",
          fieldText: "call Ralph very very Great",
        }),
      ).toEqual(["Great"]);
    });

    it("does not learn from a self-overlapping dictation the field never got", () => {
      expect(
        find({
          insertedText: "very very good",
          baselineText: "Draft note very very good",
          fieldText: "DRAFT note very very good",
        }),
      ).toEqual([]);
    });
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

  it("does not read a curly quote as a correction", () => {
    // The target app curly-quoted the proper noun on its own. That is not the
    // user editing anything, so it must not be offered as a term to learn. The
    // comparison folded nothing at all, so the quote was seen as both added and
    // removed -- and because `consumeOriginalToken` keys on the lowercased raw
    // token, the term came out as the curly-quoted spelling.
    //
    // The token has to be a capitalised proper noun to reach the term list at
    // all, which is why this is not written with a lowercase word.
    expect(
      find({
        insertedText: "i work at O'Reilly media",
        baselineText: "i work at O'Reilly media",
        fieldText: "i work at O\u2019Reilly media",
      }),
    ).toEqual([]);
  });

  it("still reads a corrected apostrophe as a correction", () => {
    // The fold is deliberately narrow: only U+2018 and U+2019 are treated as the
    // same character. A backtick where the dictation had nothing is a real edit,
    // and it must still be offered.
    expect(
      find({
        insertedText: "i work at OReilly media",
        baselineText: "i work at OReilly media",
        fieldText: "i work at O`Reilly media",
      }),
    ).not.toEqual([]);
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

  it("does not learn a word the user typed inside the dictation", () => {
    // The case the `regionStart` comment in edit-watch.utils.ts used to name:
    // `alpha beta call Ralph` against `alpha beta Zeta call Ralf` pairs the
    // dictated `call` against the typed `Zeta`, and the prompt then offers
    // `Zeta`. It did not, in fact, need `regionStart` to reach that outcome and
    // it did not avoid it either: `collectRegionTerms` summed the added and
    // removed tokens over the whole region, so the insertion rode along on the
    // real correction further along. The pairing is per gap now, so `Zeta` is
    // an insertion with nothing to replace and is not learned.
    expect(
      find({
        insertedText: "alpha beta call Ralph",
        baselineText: "alpha beta call Ralph",
        fieldText: "alpha beta Zeta call Ralf",
      }),
    ).toEqual(["Ralf"]);

    // The insertion alone learns nothing either, with or without a correction
    // somewhere else in the same field.
    expect(
      find({
        insertedText: "alpha beta call Ralph",
        baselineText: "alpha beta call Ralph",
        fieldText: "alpha beta Zeta call Ralph",
      }),
    ).toEqual([]);

    // `Ralf` in the first case is the real correction in the same region, and it
    // is still learned. The per-gap pairing drops the insertion; it does not drop
    // the replacement that sits beside it.
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

    it("learns a replacement of the first dictated word beside typed text", () => {
      // The user typed `Note` in front of the dictation, swapped the first
      // dictated word for `Zeta`, and fixed the last one. `Note` is outside
      // the dictation and must not be offered; `Zeta` replaced a dictated word
      // and must be, which is why the leading run is not clamped tight to the
      // first surviving token.
      expect(
        find({
          insertedText: "call alpha beta Ralph",
          baselineText: "x call alpha beta Ralph",
          fieldText: "x Note Zeta alpha beta Ralf",
        }),
      ).toEqual(["Zeta", "Ralf"]);
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
