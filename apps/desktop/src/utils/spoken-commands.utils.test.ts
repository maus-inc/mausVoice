import { describe, expect, it } from "vitest";
import { applySpokenCommands } from "./spoken-commands.utils";

describe("applySpokenCommands", () => {
  it("inserts a newline for new line / newline / line break", () => {
    expect(applySpokenCommands("hello new line world")).toBe("hello\nworld");
    expect(applySpokenCommands("hello newline world")).toBe("hello\nworld");
    expect(applySpokenCommands("hello line break world")).toBe("hello\nworld");
  });

  it("inserts a paragraph break", () => {
    expect(applySpokenCommands("first new paragraph second")).toBe(
      "first\n\nsecond",
    );
  });

  it("converts standalone punctuation commands", () => {
    expect(applySpokenCommands("hello comma world")).toBe("hello, world");
    expect(applySpokenCommands("Stop period Next")).toBe("Stop. Next");
    expect(applySpokenCommands("Ready question mark Yes")).toBe("Ready? Yes");
    expect(applySpokenCommands("Wow exclamation mark")).toBe("Wow!");
    expect(applySpokenCommands("Note colon value")).toBe("Note: value");
    expect(applySpokenCommands("Wait semicolon then")).toBe("Wait; then");
  });

  it("converts parentheses and quotes", () => {
    expect(applySpokenCommands("see open paren foo close paren")).toBe(
      "see (foo)",
    );
    expect(applySpokenCommands("say open quote hi close quote")).toBe(
      'say "hi"',
    );
  });

  it("keeps an explicit newline inserted before attach-left punctuation", () => {
    expect(applySpokenCommands("new line comma")).toBe("\n,");
    expect(applySpokenCommands("open paren new line close paren")).toBe("(\n)");
  });

  it("does not rewrite protected collocations", () => {
    expect(applySpokenCommands("a new line of credit")).toBe(
      "a new line of credit",
    );
    expect(applySpokenCommands("the Oxford comma matters")).toBe(
      "the Oxford comma matters",
    );
    expect(applySpokenCommands("a time period of rest")).toBe(
      "a time period of rest",
    );
    expect(applySpokenCommands("colon cancer screening")).toBe(
      "colon cancer screening",
    );
  });

  it("scratches the previous sentence", () => {
    expect(applySpokenCommands("Hello world. Scratch that. Goodbye.")).toBe(
      "Goodbye.",
    );
    expect(applySpokenCommands("Hello world scratch that")).toBe("");
    expect(applySpokenCommands("First sentence. Second scratch that")).toBe(
      "First sentence.",
    );
    expect(applySpokenCommands("Keep this. Drop that. scratch that")).toBe(
      "Keep this.",
    );
  });

  it("scratches the previous sentence when the buffer ends in a newline", () => {
    // A "new line" / "new paragraph" command leaves the buffer ending in a
    // newline. lastSentenceBoundary used to stop at that trailing newline,
    // so "scratch that" was a no-op: "Hello, new line, scratch that" kept
    // "Hello," instead of dropping it.
    expect(applySpokenCommands("Hello, new line, scratch that")).toBe("");
    expect(applySpokenCommands("First. Second. new line scratch that")).toBe(
      "First.",
    );
    expect(
      applySpokenCommands("First paragraph. Second new paragraph scratch that"),
    ).toBe("First paragraph.");
  });

  it("keeps the space after a partial scratch", () => {
    expect(
      applySpokenCommands("First sentence. Second, scratch that, more"),
    ).toBe("First sentence. more");
  });

  it("stacks scratch that", () => {
    expect(applySpokenCommands("one two scratch that scratch that")).toBe("");
  });

  it("leaves non-English text unchanged", () => {
    expect(applySpokenCommands("bonjour new line monde", "fr")).toBe(
      "bonjour new line monde",
    );
  });

  it("returns empty and untouched inputs as-is", () => {
    expect(applySpokenCommands("")).toBe("");
    expect(applySpokenCommands("   ")).toBe("   ");
    expect(applySpokenCommands("plain speech")).toBe("plain speech");
  });

  it("handles trailing punctuation on the command word", () => {
    expect(applySpokenCommands("hello comma, world")).toBe("hello, world");
  });

  it("does not treat delete that or undo that as commands", () => {
    expect(applySpokenCommands("please delete that file")).toBe(
      "please delete that file",
    );
    expect(applySpokenCommands("undo that change")).toBe("undo that change");
  });

  it("does not treat Dr. as a sentence boundary for scratch that", () => {
    expect(applySpokenCommands("See Dr. Smith scratch that")).toBe("");
  });

  it("applies English commands for auto but not explicit non-English languages", () => {
    expect(applySpokenCommands("hello new line world", "auto")).toBe(
      "hello\nworld",
    );
    expect(applySpokenCommands("hello new line world", "primary")).toBe(
      "hello new line world",
    );
    expect(applySpokenCommands("hello new line world", "de")).toBe(
      "hello new line world",
    );
  });

  it("preserves leading and trailing whitespace", () => {
    expect(applySpokenCommands("  hello world  ")).toBe("  hello world  ");
  });

  it("leaves aligned or tabbed text unchanged when no command matches", () => {
    expect(applySpokenCommands("const  x\t=\t1")).toBe("const  x\t=\t1");
    expect(applySpokenCommands("col1   col2\n  indented")).toBe(
      "col1   col2\n  indented",
    );
  });

  it("keeps original gaps around a matched command", () => {
    expect(applySpokenCommands("hello  comma  world")).toBe("hello,  world");
  });

  it.each([
    "I finished the report. I'll scratch that off my to-do list.",
    "Let's scratch that idea and start over.",
    "We should scratch that from the agenda.",
    "Hello world scratch that goodbye",
    "The billing period ends on Friday.",
    "During the period we saw strong growth.",
    "My period was late.",
    "The sprint period ends Friday.",
    "The observation period lasted six weeks.",
    "We extended the notice period.",
    // One per deny-list entry added for the `period` command, so the list
    // cannot rot entry by entry: a modifier removed from
    // `blockedPredecessors` fails the case that names it.
    //
    // Each one ends on the command word. That is the only position where the
    // deny-list runs at all: `clauseFinal` rejects a mid-sentence "period", so a
    // case that continues past it would pass whether or not the entry existed,
    // and would be testing the wrong gate.
    "The semester period",
    "We had a sprint period",
    // The pre-existing case for this modifier continues past the command word,
    // so `clauseFinal` rejects it and the deny-list never runs. Without an
    // end-position case the entry could be deleted and the suite would not
    // notice.
    "The observation period",
    "The quarter period",
    "The registration period",
    "The exercise period",
    "The correction period",
    "We are in a hold period",
    "The embargo period",
    "The deprecation period",
    "The beta period",
    "We're launching a new line today.",
    "Can you read the next line for me?",
    "Put a comma after the name.",
    "The colon is part of the large intestine.",
    "Where does the question mark go?",
    "Add a semicolon there.",
    "That was a full stop for the project.",
    "Remove that comma.",
  ])("leaves ordinary speech unchanged: %s", (sentence) => {
    expect(applySpokenCommands(sentence)).toBe(sentence);
  });

  it.each([
    ["Hello world scratch that new paragraph Goodbye", "\n\nGoodbye"],
    ["Hello world scratch that period", "."],
    ["Stop period next line Go", "Stop.\nGo"],
    ["That is final period", "That is final."],
    ["I'm done period See you", "I'm done. See you"],
    ["hello comma world", "hello, world"],
  ])("still applies genuine commands: %s", (input, expected) => {
    expect(applySpokenCommands(input)).toBe(expected);
  });

  it.each([
    "the difficult period Apple faced",
    "it was a quiet period Sarah remembered fondly",
    "revenue fell during a rough period Microsoft reported",
    "I'll scratch that Netflix subscription",
  ])(
    "keeps a command word literal before a capitalized name: %s",
    (sentence) => {
      expect(applySpokenCommands(sentence)).toBe(sentence);
    },
  );

  it.each([
    ["I finished period Then I left", "I finished. Then I left"],
    ["I finished period I left early", "I finished. I left early"],
    [
      "Thanks for the help period Best regards",
      "Thanks for the help. Best regards",
    ],
    ["It works period The tests pass", "It works. The tests pass"],
    ["Hello world scratch that The plan changed", "The plan changed"],
  ])(
    "still treats a capitalized sentence opener as a new sentence: %s",
    (input, expected) => {
      expect(applySpokenCommands(input)).toBe(expected);
    },
  );

  it("leaves a mid-sentence period alone even when meant as a command", () => {
    // A lowercase word straight after "period" reads as the noun. Speakers
    // who pause get a comma or capital from the model, which does apply.
    expect(applySpokenCommands("hello period how are you")).toBe(
      "hello period how are you",
    );
    expect(applySpokenCommands("hello period, how are you")).toBe(
      "hello. how are you",
    );
  });

  it.each([
    "Hello world scratch that new line of credit",
    "Hello world scratch that period of time",
    "Hello world scratch that the next line",
    "ok period and I'll scratch that",
  ])(
    "does not count a following phrase that is not a command: %s",
    (sentence) => {
      expect(applySpokenCommands(sentence)).toBe(sentence);
    },
  );

  it("does not close a clause with a structural command skipped in interim text", () => {
    const options = { skipStructuralCommands: true };
    expect(applySpokenCommands("hello period new line", "en", options)).toBe(
      "hello period new line",
    );
    expect(applySpokenCommands("hello period new line")).toBe("hello.\n");
  });

  it("does not let a listed noun block across punctuation", () => {
    expect(applySpokenCommands("Show some grace. Period.")).toBe(
      applySpokenCommands("Show some care. Period.").replace("care", "grace"),
    );
    expect(applySpokenCommands("Pay the notice. Period.")).toBe(
      applySpokenCommands("Pay the invoice. Period.").replace(
        "invoice",
        "notice",
      ),
    );
  });

  it("treats a word closed off by punctuation as outside the command", () => {
    expect(applySpokenCommands("Keep this. We. Scratch that.")).toBe(
      "Keep this.",
    );
    expect(applySpokenCommands("Keep this. We scratch that.")).toBe(
      "Keep this. We scratch that.",
    );
  });

  it("skips scratch and newlines on interim chunks", () => {
    expect(
      applySpokenCommands("hello new line scratch that", "en", {
        skipStructuralCommands: true,
      }),
    ).toBe("hello new line scratch that");
  });

  describe("a command word inside a noun phrase is not a command", () => {
    it("covers every case in this note", () => {
      // "comma" was in the command list with `blockedPredecessors` but no
      // `blockedFollowers`, and the modifier in this phrase FOLLOWS the head. So the
      // command fired and removed the word from the middle of a noun phrase:
      //
      //   "comma separated values"               ->  ", separated values"
      //   "the file holds comma separated values" ->  "the file holds, separated values"
      //
      // That is silent data loss, which this module rates above a miss that only
      // mispunctuates. "a comma separated list" was already spared, by the determiners
      // rule, which is why only part of this shape was corrupting.
      for (const input of [
        "comma separated values",
        "the file holds comma separated values",
        "comma delimited",
        "the comma separated rule applies",
        "names comma separated, ages comma separated",
      ]) {
        expect(applySpokenCommands(input)).toBe(input);
      }

      // The command itself is unaffected.
      for (const [input, expected] of [
        ["hello comma world", "hello, world"],
        ["one two comma three comma four", "one two, three, four"],
        ["comma", ","],
        // `blockedPredecessors` still holds for the modifiers in front.
        ["the Oxford comma matters", "the Oxford comma matters"],
        ["Put a comma after the name.", "Put a comma after the name."],
      ] as const) {
        expect(applySpokenCommands(input)).toBe(expected);
      }

      // A blocked follower also withdraws `comma` from `commandFollowsAt`, so a
      // `period` before the same noun phrase stops firing. That is a change to
      // `period` behaviour caused from the `comma` entry, so it is pinned here too.
      expect(applySpokenCommands("values period comma delimited list")).toBe(
        "values period comma delimited list",
      );

      // One input changes reading rather than corrupting: "values comma separated by
      // tab" used to become "values, separated by tab" and now stays literal. The
      // speaker is describing comma separation rather than asking for a mark, so the
      // literal reading is the better of the two.
      expect(applySpokenCommands("values comma separated by tab")).toBe(
        "values comma separated by tab",
      );
    });
  });

  describe("a quotative 'scratch that' is not the command", () => {
    it("covers every case in this note", () => {
      // "scratch that" is ordinary English as the object of a reporting verb. The
      // clause-subject deny-list is what keeps the command from firing there, and it
      // held only pronouns, modals, auxiliaries and negations. "The manager said
      // scratch that." passed the gate, reached `applyScratch`, found no sentence
      // boundary before the command and cleared the whole buffer -- so a quotative
      // use deleted the dictation. This file rates a miss that only mispunctuates a
      // cosmetic error and puts data loss above it.
      for (const input of [
        "The manager said scratch that.",
        "She asked scratch that.",
        "I wrote scratch that in the notes.",
        "He repeated scratch that.",
        "He told scratch that.",
        // And the damaging shape: an earlier sentence that must survive intact.
        "I sent the invoice. The manager said scratch that.",
      ]) {
        expect(applySpokenCommands(input)).toBe(input);
      }

      // The real command still fires, including where the boundary is what makes the
      // scratch well-defined. These are the cases the existing suite already pins,
      // restated here because the deny-list that protects them was widened.
      expect(applySpokenCommands("Hello world scratch that")).toBe("");
      expect(applySpokenCommands("First sentence. Second scratch that")).toBe(
        "First sentence.",
      );
      expect(applySpokenCommands("Keep this. Drop that. scratch that")).toBe(
        "Keep this.",
      );
      expect(applySpokenCommands("one two scratch that scratch that")).toBe("");
      expect(applySpokenCommands("See Dr. Smith scratch that")).toBe("");
      expect(applySpokenCommands("First. Second. new line scratch that")).toBe(
        "First.",
      );

      // The deny-list entries this module added for `scratch that` itself. Each of
      // these has the command word inside a clause that cannot be one.
      for (const input of [
        "I finished the report. I'll scratch that off my to-do list.",
        "Let's scratch that idea and start over.",
        "We should scratch that from the agenda.",
      ]) {
        expect(applySpokenCommands(input)).toBe(input);
      }

      // What the deny-list cannot do, stated so it is not mistaken for coverage: it
      // looks only at the token immediately before the command. "told me scratch
      // that" puts "me" there, and "me" is not a reporting verb, so that shape still
      // clears the buffer. Catching it needs the whole clause, which is a different
      // gate from the one widened above.
      expect(applySpokenCommands("He told me scratch that.")).toBe("");
    });
  });
});
