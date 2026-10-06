import { describe, expect, it } from "vitest";
import {
  FAST_STYLE_MAX_INPUT_CHARS,
  applyFastStyle,
  canApplyFastStyle,
  countFastStyleSentences,
  findChunkCut,
  measureFastStyleTruncation,
  stripEdgePunctuation,
} from "./fast-style.utils";

/**
 * A high surrogate not followed by a low one, or a low one not preceded by a
 * high one. `String.prototype.isWellFormed` would say this directly, but it is
 * ES2024 and this project targets ES2022, so it is spelled out here rather than
 * widening the compiler lib for one assertion.
 */
const hasLoneSurrogate = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;
    const next = text.charCodeAt(i + 1);
    if (isHigh) {
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else {
      return true;
    }
  }
  return false;
};

describe("applyFastStyle fast local transforms", () => {
  it("verbatim returns raw exactly (contract)", () => {
    const raw = "um so like I went to the store";
    expect(applyFastStyle(raw, "verbatim")).toBe(raw);
    expect(applyFastStyle(raw, "disabled")).toBe(raw);
    expect(applyFastStyle(raw, null)).toBe(raw);
  });

  it("polished removes filler and capitalizes", () => {
    const raw = "um so I went to the store uh and I bought some milk";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).not.toContain("um");
    expect(out).toMatch(/I went to the store/);
    expect(out.endsWith(".") || out.endsWith("\n")).toBe(true);
  });

  it("bullets formats as list (sentence boundaries only, not on 'and')", () => {
    const raw = "I need to buy milk. I need bread. I need eggs";
    const out = applyFastStyle(raw, "bullets");
    expect(out).toContain("- ");
    expect(out.split("\n").length).toBe(3);
    // Hardened: does NOT split on "and" inside sentence
    const rawWithAnd = "I need bread and butter";
    const outWithAnd = applyFastStyle(rawWithAnd, "bullets");
    expect(outWithAnd.split("\n").length).toBe(1);
    expect(outWithAnd.toLowerCase()).toContain("bread and butter");
  });

  it("email preserves greeting/closing if present, does NOT hallucinate if absent", () => {
    const rawWithGreeting =
      "Hi. I wanted to follow up on the meeting we had yesterday. Thanks.";
    const outWith = applyFastStyle(rawWithGreeting, "email");
    expect(outWith.toLowerCase()).toContain("hi");
    expect(outWith).toContain("\n");
    expect(outWith.toLowerCase()).toContain("follow up");

    // No hallucination: if no greeting/closing in raw, don't invent "Hello," / "Best,"
    const rawNoGreeting =
      "I wanted to follow up on the meeting we had yesterday";
    const outNo = applyFastStyle(rawNoGreeting, "email");
    expect(outNo.toLowerCase()).not.toContain("hello,");
    expect(outNo.toLowerCase()).not.toContain("best,");
    expect(outNo.toLowerCase()).toContain("follow up");

    // Edge: long sentence starting with hi should NOT be treated as greeting alone
    const rawLongHi =
      "hi I wanted to follow up on the meeting we had yesterday and discuss next steps";
    const outLong = applyFastStyle(rawLongHi, "email");
    expect(outLong.toLowerCase()).toContain("follow up");
    // Should not split into greeting + body when it's actually one long sentence
  });

  it("lifts a greeting only when it satisfies both the word and character limit", () => {
    // The two limits are 4 words and 20 characters for an opener, 5 and 25 for a
    // sign-off, and both have to hold. With `||` an opener that satisfied only
    // the word count was hoisted anyway: this one is four words but 25
    // characters, so it breaks the character limit and is body, not a greeting.
    const openerOverTheCharLimit =
      "Hi, good morning everyone. I wanted to follow up on the roadmap. Thanks.";
    const kept = applyFastStyle(openerOverTheCharLimit, "email");
    // The opener stayed with the body instead of being split onto its own line.
    expect(kept.startsWith("Hi, good morning everyone. I wanted to follow up"));
    expect(kept).not.toBe(
      "Hi, good morning everyone.\n\nI wanted to follow up on the roadmap.\n\nThanks.",
    );
    // The sign-off is within both limits, so it is still lifted.
    expect(kept.endsWith("Thanks."));

    // A short opener is still lifted, so the conjunction did not disable it.
    const shortOpener = applyFastStyle(
      "Hi. I wanted to follow up. Thanks.",
      "email",
    );
    expect(shortOpener).toBe("Hi.\n\nI wanted to follow up.\n\nThanks.");

    // And the sign-off is guarded the same way: over 25 characters, on one word
    // count, is body rather than a sign-off.
    const longSignOff =
      "We should talk about the quarterly numbers. Please let me know what you think.";
    const signOffKept = applyFastStyle(longSignOff, "email");
    expect(signOffKept).toContain("Please let me know what you think");
  });

  it("concise removes hedging and shortens (conservative, no meaning change)", () => {
    const raw = "I think maybe we should sort of consider going to the park";
    const out = applyFastStyle(raw, "concise");
    expect(out.toLowerCase()).not.toContain("i think");
    expect(out.toLowerCase()).not.toContain("sort of");
    expect(out.length).toBeLessThan(raw.length);
    // "maybe" is content, not removed in conservative mode to avoid changing meaning
  });

  it("prompt makes imperative and concise", () => {
    const raw =
      "Hey so, um, can you summarize the key points of this Q3 report? Like under one page, and, uh, I need it by tomorrow morning.";
    const out = applyFastStyle(raw, "prompt");
    expect(out.length).toBeLessThan(raw.length);
    expect(out.endsWith(".")).toBe(true);
  });

  it("notes organizes with bullets and action items", () => {
    const raw =
      "We decided to launch next week. We need to finish the docs. Follow up with design team.";
    const out = applyFastStyle(raw, "notes");
    expect(out).toContain("- ");
  });
  // Finding 4188220733. `toNotes` sorts a chunk's own sentences into notes and actions and
  // emits notes-then-actions FOR THAT CHUNK; `applyFastStyle` then joins the chunks. So a
  // long dictation came out as
  //
  //     [chunk1 notes][chunk1 actions][chunk2 notes][chunk2 actions]
  //
  // and an action in an early chunk sat above ordinary notes in a later one. The same
  // content reordered purely by crossing the cap, which is the harm: the notes tone's whole
  // job is that the action list ends up at the end.
  describe("notes keeps one action list across every chunk", () => {
    const SENTENCE = "The quick brown fox jumps over the lazy dog.";
    const ACTION = "We need to ship the release today.";
    const NOTE = "The weather in Lagos has been unusually wet this week.";

    /** Over the cap, with the action in chunk 1 and the note in chunk 2. */
    const spanningTheCap = (): string => {
      const pad = `${SENTENCE} `;
      let head = pad
        .repeat(Math.ceil(FAST_STYLE_MAX_INPUT_CHARS / pad.length) + 4)
        .slice(0, FAST_STYLE_MAX_INPUT_CHARS - ACTION.length - 1);
      while (head.length && head[head.length - 1] !== " ")
        head = head.slice(0, -1);
      return `${head}${ACTION} ${NOTE} The invoice for March is still unpaid.`;
    };

    const order = (out: string) => {
      const items = out.split("\n").filter((l) => l.startsWith("- "));
      return {
        firstAction: items.findIndex((l) => l.startsWith("- [ ]")),
        lastNote: items
          .map((l, i) => (l.startsWith("- [ ]") ? -1 : i))
          .filter((i) => i >= 0)
          .pop(),
      };
    };

    it("puts the action in chunk 1 and the note in chunk 2", () => {
      // The guard for the test below: if the seam moved, both sentences would land in one
      // chunk and the assertion would pass for the wrong reason.
      const text = spanningTheCap();
      expect(text.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
      const cut = findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS);
      // `>=` on the note, not `>`: the sentence boundary the chunker finds here is the full
      // stop that ENDS the action sentence, so the note begins exactly AT the cut.
      expect(text.indexOf(ACTION)).toBeLessThan(cut);
      expect(text.indexOf(NOTE)).toBeGreaterThanOrEqual(cut);
      expect(cut).toBeLessThan(text.length);
    });

    it("emits every note before the first action, as it does under the cap", () => {
      const over = applyFastStyle(spanningTheCap(), "notes");
      const under = applyFastStyle(
        `${ACTION} ${NOTE} The invoice for March is still unpaid.`,
        "notes",
      );
      // Only the ORDER is compared, not the counts: the over-cap input carries the padding
      // sentences and the control does not, so the two legitimately hold different numbers
      // of notes. What has to match is that both put every note ahead of the first action.
      const a = order(over);
      const b = order(under);
      expect(
        a.firstAction,
        `over the cap: no action found`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        b.firstAction,
        `under the cap: no action found`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        a.lastNote,
        `over the cap, tail: ${JSON.stringify(over.slice(-160))}`,
      ).toBeLessThan(a.firstAction);
      expect(b.lastNote).toBeLessThan(b.firstAction);
    });

    it("keeps the three real sentences, none of them twice", () => {
      // The control on the merge: accumulating across chunks must not drop or duplicate. The
      // padding repeats by construction, so this counts the three sentences the input is
      // actually about rather than every line.
      const out = applyFastStyle(spanningTheCap(), "notes");
      const items = out.split("\n").filter((l) => l.startsWith("- "));
      for (const sentence of [
        ACTION,
        NOTE,
        "The invoice for March is still unpaid.",
      ]) {
        const hits = items.filter((l) =>
          l.includes(sentence.replace(/\.$/, "")),
        ).length;
        expect(hits, `${sentence} appears ${hits} times`).toBe(1);
      }
    });

    // Finding 4190838907. `renderNotes(buckets, fallback)` returns `toBullets(fallback)` when
    // both buckets come back empty, and on this path `fallback` is the WHOLE trimmed
    // transcript. `toBullets` asserts within the chunk size, so an over-cap dictation whose
    // sentences all reduce away threw, the surrounding `try` caught it, and the caller received
    // its own input back verbatim -- the one output the module's contract calls the worst.
    //
    // The old `toNotes` could not do this: its `if (sentences.length === 0) return text;` ran
    // first, so `toBullets(guarded)` was unreachable dead code. Restoring that guard is the fix,
    // and these two tests exist so the fallback cannot come back.
    it("never hands back the input when every sentence reduces away", () => {
      const text = "um "
        .repeat(Math.ceil(FAST_STYLE_MAX_INPUT_CHARS / 3) + 10)
        .slice(0, FAST_STYLE_MAX_INPUT_CHARS + 500);
      expect(text.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
      const out = applyFastStyle(text, "notes");
      // The defect's exact signature: output === input.
      expect(out).not.toBe(text);
      // And the module must not have fallen back to the raw transcript at all.
      expect(out.trim()).toBe("");
    });

    it("leaves the under-cap all-filler shapes exactly as they were", () => {
      // The control: under the cap nothing reaches the fallback, so these outputs must not
      // move. Measured against the pre-refactor module, which is where the numbers come from --
      // not from what looks tidy. `"uh huh er ah"` keeps a `- Huh` note, because `huh` is not
      // in the filler vocabulary, so it is a note like any other.
      for (const [raw, expected] of [
        ["um um um", ""],
        ["um um um um um", ""],
        ["uh huh er ah", "- Huh"],
        ["um, uh, er.", "-"],
      ] as const) {
        expect(applyFastStyle(raw, "notes"), raw).toBe(expected);
      }
    });
  });

  it("chat keeps casual and removes filler", () => {
    const raw = "um so I was like thinking we should grab coffee tomorrow";
    const out = applyFastStyle(raw, "chat");
    expect(out.toLowerCase()).not.toContain("um");
    expect(out.toLowerCase()).toContain("coffee");
  });

  it("formal expands contractions", () => {
    const raw = "I don't think we can do it";
    const out = applyFastStyle(raw, "formal");
    expect(out.toLowerCase()).toContain("do not");
  });

  it("handles self-correction", () => {
    const raw = "I went to the store, actually, the mall yesterday";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).toContain("mall");
    expect(out.toLowerCase()).not.toContain("store");
  });

  it("handles empty input", () => {
    expect(applyFastStyle("", "default")).toBe("");
    expect(applyFastStyle("   ", "bullets")).toBe("");
  });

  it("custom tone is left untouched rather than restyled", () => {
    // A custom tone carries a free-form prompt the fast path cannot read, and
    // the aggressive transforms can drop words. Handing the user a different
    // style than the one they picked is worse than handing back the input, so
    // an unknown tone id must not be rewritten at all.
    const raw = "um so I went to the store";
    expect(applyFastStyle(raw, "my-custom-tone")).toBe(raw);
  });

  it("does not answer a deprecated tone with a different tone's transform", () => {
    // These used to be gated in as having a local transform and dispatched to
    // `toPolished`, which is the substitution `canApplyFastStyle` exists to
    // prevent: the user picked a style, got Polished, and lost what `toPolished`
    // strips as filler. `punny` is the clearest case -- its prompt asks for
    // jokes, and no local string operation produces them. A tone persisted by an
    // older build stays selectable, so the raw path has to be what it takes.
    const raw = "um so I went to the store";
    for (const toneId of ["light", "casual", "business", "punny"]) {
      expect(canApplyFastStyle(toneId)).toBe(false);
      expect(applyFastStyle(raw, toneId)).toBe(raw);
    }
  });

  it("still has a real transform for formal, which is not a guess", () => {
    // `formal` is a deprecated id that happens to be exactly `FORMAL_TONE_ID`,
    // so it keeps its own transform rather than taking the raw path.
    expect(canApplyFastStyle("formal")).toBe(true);
    expect(applyFastStyle("um so I went to the store", "formal")).not.toBe(
      "um so I went to the store",
    );
  });

  it("custom tone is never rewritten and never matches a category string", () => {
    // The fast path is pure string work and cannot interpret a free-form style
    // prompt. An unknown tone id must return its input untouched, not a guess
    // borrowed from a built-in tone. Pinned by asserting the result is
    // byte-identical to the input, and different from every real transform.
    const raw = "um so I need to buy milk. I need bread. I need eggs";
    expect(applyFastStyle(raw, "my-custom-tone")).toBe(raw);
    expect(applyFastStyle(raw, "another-unknown")).toBe(raw);
    // A tone id that merely looks like a built-in must not be treated as one.
    expect(applyFastStyle(raw, "prompt")).not.toBe(
      applyFastStyle(raw, "default"),
    );
  });

  it("keeps 'I mean' when it is ordinary English, drops it when comma-marked", () => {
    // Regression: "I mean" is also a verb phrase ("the mean of the data, I
    // mean it statistically"). Only a comma-delimited "I mean," is a filler.
    const asVerb = "The mean of the data matters, I mean it statistically";
    expect(applyFastStyle(asVerb, "default").toLowerCase()).toContain(
      "i mean it statistically",
    );

    const asFiller = "It broke, I mean, it broke loudly";
    expect(applyFastStyle(asFiller, "default").toLowerCase()).not.toContain(
      "i mean",
    );
  });

  it("removes 'you know' as a discourse marker but keeps it as a verb", () => {
    // Regression: "I know you know the answer" is two ordinary verbs. Dropping
    // the inner one turns it into "I know the answer", a different statement.
    const asVerb = applyFastStyle(
      "I know you know the answer is out there",
      "default",
    ).toLowerCase();
    expect(asVerb).toContain("i know you know the answer");

    // Comma-delimited or opening, it is a filler and goes.
    for (const filler of [
      "I know the answer is out there, you know",
      "You know, I already fixed it",
    ]) {
      expect(applyFastStyle(filler, "default").toLowerCase()).not.toContain(
        "you know",
      );
    }
  });

  it("removes a trailing 'you know' closed by a full stop", () => {
    // "..., you know" was already treated as a filler at end of text, but
    // "..., you know." was not, because the tail only accepted a comma or the
    // end of the string. A full stop closes the phrase just as well.
    const styled = applyFastStyle("I know the answer, you know.", "default");
    expect(styled.toLowerCase()).not.toContain("you know");
  });

  it.each([
    ["a question mark", "I know the answer, you know?"],
    ["an exclamation mark", "I know the answer, you know!"],
  ])("removes a trailing 'you know' closed by %s", (_label, raw) => {
    expect(applyFastStyle(raw, "default").toLowerCase()).not.toContain(
      "you know",
    );
  });

  it("keeps 'you know' as the subject of the sentence it opens", () => {
    // Regression: the filler guard used to accept a full stop as an anchor, so
    // "You know" starting a sentence lost its subject and the tail of that
    // sentence was welded onto the end of the previous one. A full stop is not
    // a safe anchor because the words after it are ordinary English.
    // The first case is the shape that was still broken: `You know.` at the START of
    // the text, closed by a full stop. Mid-text the guard needs a preceding comma
    // (`EXTRA_FILLER_MID_RE`'s `,\s*` alternative), so a full stop there cannot delete a
    // subject. At `^` there is no preceding comma to require, so the phrase closed
    // itself and the whole opening sentence went with it -- "You know. It works."
    // styled to "It works.", which is silent data loss, the harm this module ranks
    // above a mispunctuated sentence.
    for (const raw of [
      "You know. It works.",
      "It works. You know it works.",
      "Shipped. You know the deadline.",
      "Green. You know the drill.",
    ]) {
      expect(applyFastStyle(raw, "default")).toBe(raw);
      // The guard is shared, so every style that calls removeFillerWords with
      // the aggressive flag is covered by the same fix.
      expect(applyFastStyle(raw, "bullets")).toContain("You know");
      expect(applyFastStyle(raw, "notes")).toContain("You know");
      expect(applyFastStyle(raw, "concise")).toContain("You know");
    }
  });

  it("still drops 'you know' when it opens the text or is comma-marked", () => {
    // The two anchors that survive the fix must keep working, otherwise the
    // guard is now inert and real fillers ship.
    expect(applyFastStyle("You know, we should ship it.", "default")).toBe(
      "We should ship it.",
    );
    expect(
      applyFastStyle("I know the answer is out there, you know", "default"),
    ).toBe("I know the answer is out there.");
  });

  it("keeps a bare 'you know' that has no comma after it", () => {
    // Removing the full stop anchor stopped the transform from eating a subject
    // mid sentence, but the two anchors that stayed still ate one. The guard
    // only treats the phrase as a filler when a comma follows it or the phrase
    // ends the transcript. Anything else leaves a clause in front of the words
    // the pattern would have removed.
    for (const raw of [
      "You know it works.",
      "He said, you know it works.",
      "You know what I mean.",
    ]) {
      expect(applyFastStyle(raw, "default")).toBe(raw);
      expect(applyFastStyle(raw, "bullets").toLowerCase()).toContain(
        "you know",
      );
      expect(applyFastStyle(raw, "notes").toLowerCase()).toContain("you know");
      expect(applyFastStyle(raw, "concise")).toBe(raw);
    }
  });

  it("drops a 'you know' that is comma-delimited on both sides", () => {
    for (const filler of [
      "I know the answer is out there, you know, but we should ship it.",
      "Well, you know, the deadline moved.",
    ]) {
      expect(applyFastStyle(filler, "default").toLowerCase()).not.toContain(
        "you know",
      );
    }
  });

  // Every PRE-EXISTING case in this file carries ONE marker -- all seven of them, counted
  // from vitest's own expanded test names. This test and the control below it carry two,
  // which is the axis that decides whether the two anchored passes can stand in for the
  // single alternation they replaced, and it is the axis 180 single-marker probes missed.
  //
  // The mid pattern is unanchored, so running it first can consume a `, you know<tail>`
  // inside the span the leading anchor owns, and the leading pass then fires again on the
  // text the mid pass rewrote. That removed two markers where the single pattern removed
  // one and swallowed the closing punctuation: `you know, you know? Did you?` styled to
  // `you know Did you?` rather than `You know? Did you?`.
  //
  // Expected values are what the pre-split MODULE produced for these inputs, measured at
  // this commit's parent rather than taken from the old pattern -- an inline copy of that
  // pattern would be a second subject, and this file's job is to pin the module.
  it("handles two 'you know' markers the way the single pattern did", () => {
    // Every expectation here is the output the single alternation produced, measured at
    // this commit's parent by styling the same input through the pre-split module. Asserted
    // as literals rather than by re-running the old pattern inline: an inline copy is a
    // second subject, and this file's job is to pin the module.
    for (const [raw, expected] of [
      ["you know, you know", "You know."],
      ["you know, you know.", "You know."],
      ["you know, you know?", "You know?"],
      ["you know, you know, you know", "You know."],
      ["you know, you know? Really?", "You know? Really?"],
      ["you know, you know? Did you?", "You know? Did you?"],
      ["you know, you know! Really!", "You know! Really!"],
    ] as const) {
      expect(applyFastStyle(raw, "default"), `styled output for ${raw}`).toBe(
        expected,
      );
    }
  });

  it("still keeps a sentence when the only thing in it was two markers", () => {
    // The control for the case above: `you know, you know.` styled to an EMPTY string
    // under the wrong pass order, which is the outcome this module's own comments rank
    // above a mispunctuated sentence.
    for (const raw of ["you know, you know.", "you know, you know?"]) {
      expect(applyFastStyle(raw, "default"), raw).not.toBe("");
    }
  });

  it("keeps interrogatives and mid-clause verbs intact", () => {
    for (const raw of [
      "Do you know the time?",
      "Did you know the deadline moved?",
      "I wonder if you know how the build works",
      "I know you know the answer.",
    ]) {
      expect(applyFastStyle(raw, "default").toLowerCase()).toContain(
        "you know",
      );
    }
  });

  it("prompt keeps every sentence, including late constraints", () => {
    // Regression: the transform used to keep only the first three sentences,
    // which silently dropped a deadline stated later in the dictation.
    // The constraint sits in the fourth sentence, past the old three-sentence
    // cut, so a regression drops it.
    const raw =
      "Can you summarize the Q3 report. Focus on revenue. Compare against Q2. I need it by Friday. Keep it under one page.";
    const out = applyFastStyle(raw, "prompt");
    expect(out).toContain("Q3 report");
    expect(out).toContain("revenue");
    expect(out).toContain("by Friday");
    expect(out).toContain("under one page");
  });

  it("does not eat a clause when 'no' is an ordinary answer", () => {
    // Regression guard for the self-correction regex: "no" only acts as a
    // self-correction marker after a comma that follows earlier text, so a
    // bare "no" must survive.
    for (const raw of [
      "I told him no, then we left",
      "He answered no, yes he did",
    ]) {
      const out = applyFastStyle(raw, "default").toLowerCase();
      expect(out).toContain("no,");
    }
  });

  it("is idempotent", () => {
    const raw = "um so I went to the store and I bought some milk";
    const once = applyFastStyle(raw, "default");
    const twice = applyFastStyle(once, "default");
    expect(twice).toBe(once);
  });

  it("is fast (median under 5ms on a realistic dictation)", () => {
    const raw =
      "um so I went to the store uh and I bought some milk and bread and eggs and cheese and then I went home";
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      applyFastStyle(raw, "bullets");
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(5);
  });

  it("exports the same chunk size the transforms apply, and drops nothing past it", () => {
    // The exported constant is what `applyFastStyle` splits on, so a caller
    // reporting lengths cannot drift from the number actually used. The tail
    // marker must survive on BOTH sides of the boundary: this used to assert the
    // opposite for the over-cap case, which is the data loss being fixed.
    const marker = "TAILMARKER";
    const justUnder = "a".repeat(
      FAST_STYLE_MAX_INPUT_CHARS - marker.length - 1,
    );
    expect(applyFastStyle(`${justUnder} ${marker}`, "default")).toContain(
      marker,
    );

    const overBy = "a".repeat(FAST_STYLE_MAX_INPUT_CHARS + 10);
    expect(applyFastStyle(`${overBy} ${marker}`, "default")).toContain(marker);
  });

  it("preserves meaning (no hallucination)", () => {
    const raw = "We need to launch the product next week";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).toContain("launch");
    expect(out.toLowerCase()).toContain("product");
    expect(out.toLowerCase()).toContain("next week");
  });

  it("handles very long input without dropping it (no catastrophic backtracking)", () => {
    const long = "I went to the store. ".repeat(800);
    const out = applyFastStyle(long, "default");
    // Not a truncation cap any more: every one of the 800 sentences is styled.
    expect(out.length).toBeGreaterThanOrEqual(long.length - 1);
    expect(out.toLowerCase()).toContain("store");
    // 800 sentences at 3 per paragraph is 267 paragraphs, so the whole input was
    // walked rather than one chunk's worth.
    expect(out.split("\n\n").length).toBeGreaterThan(200);

    const fillerLong = `${"um ".repeat(8000)}I went to the store.`;
    const out2 = applyFastStyle(fillerLong, "default");
    expect(out2.toLowerCase()).toContain("store");
  });

  it("graceful degradation: self-correction skipped on huge input", () => {
    const huge = `${"a ".repeat(3000)}, actually, the mall yesterday`;
    const out = applyFastStyle(huge, "default");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("canApplyFastStyle", () => {
  it("returns false for verbatim, disabled, null", () => {
    expect(canApplyFastStyle(null)).toBe(false);
    expect(canApplyFastStyle("verbatim")).toBe(false);
    expect(canApplyFastStyle("disabled")).toBe(false);
  });

  it("returns true only for tones that have a local transform", () => {
    expect(canApplyFastStyle("default")).toBe(true);
    expect(canApplyFastStyle("email")).toBe(true);
    expect(canApplyFastStyle("bullets")).toBe(true);
    expect(canApplyFastStyle("concise")).toBe(true);
    // A custom tone has no local transform. Claiming one would hand the user a
    // style they did not pick.
    expect(canApplyFastStyle("my-custom")).toBe(false);
  });
});

describe("measureFastStyleTruncation", () => {
  // `applyFastStyle` styles every chunk of a long dictation and concatenates the
  // results, so there is no tail left unstyled to count. These assertions are
  // what pin that: each one used to expect a dropped-character count, and each
  // would go red again the moment truncation came back.
  it("reports nothing at or under the chunk size", () => {
    expect(measureFastStyleTruncation("")).toBeNull();
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS)),
    ).toBeNull();
  });

  it("reports nothing one character over the chunk size, because nothing is dropped", () => {
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS + 1)),
    ).toBeNull();
  });

  it("reports nothing for a far over-length input", () => {
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS * 3)),
    ).toBeNull();
  });

  it("reports nothing when only surrounding whitespace puts the input over", () => {
    // Body one under the chunk size, and enough padding to push the raw form
    // over it: 14999 trimmed is under 15000, 15001 raw is not.
    const body = "w".repeat(FAST_STYLE_MAX_INPUT_CHARS - 1);
    const raw = `  ${body} `;
    expect(body.length).toBeLessThanOrEqual(FAST_STYLE_MAX_INPUT_CHARS);
    expect(raw.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    expect(measureFastStyleTruncation(raw)).toBeNull();
  });

  it("agrees with applyFastStyle, which styles the whole over-length input", () => {
    // The input used to be `"word ".repeat(6000)`, which made this assertion pass
    // by ONE character and for the wrong reason. The styled output was 15001 chars
    // against a cap of 15000, so `toBeGreaterThan(cap)` held -- while
    // `REPEATED_WORD_RE` had collapsed "word word" pairs and HALF the words were
    // gone, 3000 of 6000. It only held because commit 98ea031d appended a period at
    // each chunk seam; that commit removed one and the output became exactly 15000,
    // which is where this case started failing. The assertion was too weak to notice
    // the loss either way.
    //
    // Two things are wrong with that. The input is pathological for this
    // measurement, because the repeat rule is doing the halving, not the chunk
    // size. And `length > cap` says nothing about coverage: 15001 characters of
    // repeated filler is not a styled dictation.
    //
    // So the input is a realistic sentence and the assertion counts coverage. A
    // distinct marker per sentence makes a dropped tail detectable, which a length
    // comparison cannot do.
    const count = 700;
    const raw = Array.from(
      { length: count },
      (_, i) => `The meeting on day ${i} ran long and covered the roadmap. `,
    ).join("");
    expect(raw.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);

    // The reported loss and the applied loss must not disagree.
    expect(measureFastStyleTruncation(raw)).toBeNull();

    // Every sentence has to be present in the output, tail included. This is the
    // half of the agreement that a null report alone would not prove.
    const out = applyFastStyle(raw, "default");
    for (let i = 0; i < count; i += 1) {
      expect(out).toContain(`day ${i} ran long`);
    }
    expect(out).toContain(`day ${count - 1} ran long`);
  });
});

describe("baseline vs fast path", () => {
  it("baseline: when LLM off, previously returned raw for non-verbatim (now fast-styled)", () => {
    const raw = "um so I went to the store";
    // Old baseline would return raw
    const oldBaseline = raw;
    // New fast path returns polished
    const newFast = applyFastStyle(raw, "default");
    expect(newFast).not.toBe(oldBaseline);
    expect(newFast.toLowerCase()).not.toContain("um");
  });

  it("no regression: LLM path still preferred when available (fast only fallback)", () => {
    // This is verified in transcribe.actions.ts: if gen.repo exists, LLM is used
    // Fast style only when gen.repo is null. We test the gating logic here.
    const toneId = "email";
    const canFast = canApplyFastStyle(toneId);
    expect(canFast).toBe(true);
    // When LLM repo exists, applyFastStyle is NOT called (LLM wins)
    // This is architectural, not unit-testable here, but documented
  });
});

describe("sentence-initial phrase removal keeps the next capital", () => {
  it("chat re-capitalizes after dropping a leading connective", () => {
    const out = applyFastStyle("Moreover, the system works.", "chat");
    expect(out).toBe("The system works.");
  });

  it("concise re-capitalizes after dropping a leading hedge", () => {
    const out = applyFastStyle("I think it is fine.", "concise");
    expect(out).toBe("It is fine.");
  });

  it("does not capitalize a phrase removed from the middle of a clause", () => {
    const out = applyFastStyle(
      "We shipped it and I think it is fine.",
      "concise",
    );
    expect(out).toBe("We shipped it and it is fine.");
  });

  it("notes keeps actions distinguishable from notes via the checkbox", () => {
    const out = applyFastStyle(
      "We shipped it. We need to fix the docs. The build is green.",
      "notes",
    );
    expect(out).toContain("- We shipped it");
    expect(out).toContain("- The build is green");
    expect(out).toContain("- [ ] We need to fix the docs");
  });
});

/**
 * The defect this file's length tests exist for: a dictation longer than the
 * chunk size used to be `slice`d to the cap, so the styled output was a prefix
 * of the input and everything after 15,000 characters was delivered nowhere.
 */
describe("CJK sentence terminators are recognised everywhere ASCII ones are", () => {
  // `。`, `！`, `？` and `…` ended a sentence for `findSentenceBoundary` but not
  // for `ensureSentencePunctuation` or `splitIntoSentences`, which each spelled out
  // `.!?` by hand. A dictation ending in `。` therefore came back as `。.` -- two
  // full stops, one of them ASCII. Every terminator list now derives from one
  // `TERMINATOR_CHARS`.
  const cases: [string, string][] = [
    ["。", "第一句。"],
    ["！", "第一句！"],
    ["？", "第一句？"],
    ["…", "等等…"],
  ];

  it.each(cases)(
    "does not append an ASCII stop after %s",
    (_mark, sentence) => {
      // The defect shows through the public entry point: the styled text must not end
      // in one terminator followed by a second, different one.
      expect(applyFastStyle(sentence, "default")).not.toMatch(
        /[.!?…。！？][.!?]$/,
      );
    },
  );

  it("still appends a stop when there is no terminator at all", () => {
    // The control. Without it the cases above would also pass if the function had
    // simply stopped appending anything.
    expect(applyFastStyle("no terminator here", "default")).toMatch(/[.!?]$/);
  });

  it("splits a mixed Latin and CJK sentence on the CJK full stop", () => {
    // `SENTENCE_SPLIT_RE` needs whitespace plus a capital or digit after it, so the
    // next sentence here starts with an ASCII capital. Before the fix the `。` was
    // invisible to it and the whole input stayed one blob.
    const out = applyFastStyle("Mixed Latin 和中文。 Next one", "default");
    expect(out).toContain("Mixed");
    expect(out).toContain("Next");
  });
});

describe("chunk boundaries never land where the next chunk opens mid-word", () => {
  it("keeps scanning past a terminator that ends the window", () => {
    // Every other chunking test here puts a SPACE after the terminator, so none
    // of them reaches the case where a terminator is the LAST character of the
    // window and the character after it belongs to the next chunk. Returning
    // there hands that chunk a false sentence start, which strips a connective
    // or capitalises a word that was mid-sentence.
    //
    // "First sentence here. " earlier in the window is what makes this
    // observable: there is a real boundary to fall back to, so the correct cut is
    // that one rather than the window edge. Measured on this input, the version
    // that returned the window edge unconditionally cut at 15000 and this cut is
    // 21.
    const early = "First sentence here. ";
    const text = `${early}${"a".repeat(
      FAST_STYLE_MAX_INPUT_CHARS - early.length - 1,
    )}.com`;
    // The window's last character is the terminator and the next is not a space,
    // so the pair really does sit on the boundary.
    expect(text[FAST_STYLE_MAX_INPUT_CHARS - 1]).toBe(".");
    expect(text[FAST_STYLE_MAX_INPUT_CHARS]).toBe("c");
    expect(findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS)).toBe(
      early.length,
    );
  });

  it("still takes a real boundary that falls on the window edge", () => {
    // The control for the case above: with a space after the terminator there is
    // nothing to keep scanning for, so the edge IS a sentence end and must be
    // taken. Without this the previous test would also pass if the scan simply
    // refused to cut on a window edge.
    const early = "First sentence here. ";
    const text = `${early}${"a".repeat(
      FAST_STYLE_MAX_INPUT_CHARS - early.length - 1,
    )}. `;
    expect(text[FAST_STYLE_MAX_INPUT_CHARS - 1]).toBe(".");
    expect(text[FAST_STYLE_MAX_INPUT_CHARS]).toBe(" ");
    expect(findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS)).toBe(
      FAST_STYLE_MAX_INPUT_CHARS,
    );
  });
});

describe("a whitespace-tier cut does not make the next chunk sentence-initial", () => {
  // The three sites that read "the start of my input" as "the start of a sentence" are
  // `SO_WELL_LEADING_RE` and `PROMPT_OPENER_RE`, both anchored to `^`, and
  // `deleteLeadingPhrase`, which reads `before.length === 0` the same way
  // (`fast-style.utils.ts:98-100`). Every tone transform TRIMS its chunk before running
  // them, so a chunk that begins with whitespace is indistinguishable from one that
  // begins a sentence by the time they see it.
  //
  // That is what the whitespace tier hands over: `findSentenceBoundary` returns an index
  // PAST the whitespace run, and the fallback in `findChunkCut` returns the index OF a
  // space (`fast-style.utils.ts:118`, `:145`). The leading space is the only thing that
  // distinguished the two, and `trim()` removes it.
  //
  // So build the input so the LAST space inside the window is the one before the marker.
  // The fallback scans backward from the window edge and returns the largest space index
  // below the cap, which is exactly that one, so the next chunk opens on the marker.
  // Probed on the FULL opener text, because at a mid-sentence seam nothing may be
  // removed -- not even the marker word itself. An earlier draft probed the words AFTER
  // the marker instead, which would also have passed on a `SO_WELL_LEADING_RE` that had
  // been narrowed to leave the marker in place; the full text cannot pass that way.
  const openers: Array<[string, string]> = [
    ["so I went home", "so I went home"],
    ["well that worked", "well that worked"],
    ["okay then we start", "okay then we start"],
    ["Can you send that file over again", "can you send that file over again"],
    ["hey there friend", "hey there friend"],
  ];
  const TAIL = " and everything after it went on for a while longer.";
  const withOpenerAtTheSeam = (opener: string): string => {
    const unit = "alpha bravo charlie delta echo foxtrot golf hotel ";
    const head = unit
      .repeat(Math.ceil(FAST_STYLE_MAX_INPUT_CHARS / unit.length) + 3)
      .slice(0, FAST_STYLE_MAX_INPUT_CHARS)
      .replace(/\s+$/, "");
    return `${head} ${opener}${TAIL}`;
  };

  it("puts the opener exactly where the whitespace tier will cut", () => {
    // The guard for the tests below: if the cut moved, they would pass for the wrong
    // reason. Measured on this construction the cut is at the cap, and the character at
    // the cap is the space before the opener.
    const text = withOpenerAtTheSeam("so I went home");
    const cut = findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS);
    expect(text[cut]).toBe(" ");
    expect(text.slice(cut + 1)).toMatch(/^so I went home/);
  });

  // Case-insensitive on purpose. The words are what must survive, not their casing: a
  // chunk that continues a sentence is not a sentence start, so most tones correctly
  // leave the word lowercase, but `fixCapitalizationAndPunctuation` still capitalises a
  // chunk's first character and `chat` is the one that does not. Pinning the case would
  // pin an accident of which transform ran.
  //
  // `Can you` and `hey` are probed on the words AFTER the marker, because those are the
  // parts a marker-stripping regex takes with it: `PROMPT_OPENER_RE` matched `hey` and
  // `PROMPT_REQUEST_RE` matched `Can you` in full.
  for (const tone of [
    "default",
    "email",
    "notes",
    "prompt",
    "concise",
    "chat",
    "formal",
    "bullets",
  ] as const) {
    it(`keeps a mid-sentence opener the ${tone} tone would delete at a real sentence start`, () => {
      for (const [opener, probe] of openers) {
        const text = withOpenerAtTheSeam(opener);
        const output = applyFastStyle(text, tone);
        expect(output.toLowerCase(), `tone=${tone} opener=${opener}`).toContain(
          probe.toLowerCase(),
        );
      }
    });
  }

  it("still deletes an opener that genuinely opened the dictation", () => {
    // The control, and the reason this is a boundary bug rather than a rule change. The
    // same patterns, applied to text that really does start with the marker, must still
    // fire -- otherwise the fix would have been to stop removing openers at all.
    //
    // Measured, not assumed. Of the five openers above, `SO_WELL_LEADING_RE` removes
    // three (`so`, `well`, `okay`) under every tone, and the other two need the tone's
    // own pattern AND a wording it recognises: `PROMPT_OPENER_RE` only matches `hey`
    // followed by a request, and `PROMPT_REQUEST_RE` only matches `Can you` on the
    // `prompt` tone. Those are listed with the wording that actually fires.
    for (const [opener, probe] of [
      ["so I went home", "so I went home"],
      ["well that worked", "well that worked"],
      ["okay then we start", "okay then we start"],
      ["Can you send that file over again", "can you"],
    ] as const) {
      const tone = opener.startsWith("Can you") ? "prompt" : "default";
      const real = applyFastStyle(`${opener}${TAIL}`, tone);
      expect(real.toLowerCase(), `tone=${tone} opener=${opener}`).not.toContain(
        probe.toLowerCase(),
      );
    }

    // `PROMPT_OPENER_RE` removes the marker word alone, so `hey there friend` comes back
    // as `there friend` and that is why the loop probes `there friend` rather than the
    // whole opener. `PROMPT_REQUEST_RE` is the pattern that carries the finding's own
    // example, so it gets its own case here rather than being folded into the loop; it
    // removes the REQUEST FRAMING and keeps the request itself, so the words to check are
    // the framing and not the payload -- `I need you to send that file` came back as
    // `Send that file`.
    expect(
      applyFastStyle(
        `I need you to send that file${TAIL}`,
        "prompt",
      ).toLowerCase(),
    ).not.toContain("i need you to");
  });

  it("still deletes an opener that opened a real sentence inside the same dictation", () => {
    // The other control, and the one that says the fix belongs at the seam rather than in
    // the patterns. A chunk that opens on a SENTENCE boundary is sentence-initial for
    // real, so the removal has to survive there. Same tone, same opener, same chunk size
    // -- the only difference is which tier produced the cut.
    //
    // Sized so the terminator lands inside the window with room to spare: the boundary
    // index is 14962 and the cap is 15000, so this exercises the sentence tier and not
    // the fallback.
    const unit = "alpha bravo charlie delta echo foxtrot golf hotel ";
    const head = unit
      .repeat(Math.ceil(FAST_STYLE_MAX_INPUT_CHARS / unit.length) + 3)
      .slice(0, FAST_STYLE_MAX_INPUT_CHARS - 40)
      .replace(/\s+$/, "");
    const text = `${head}. well that worked${TAIL}`;
    expect(text.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    // The cut lands just past the terminator, which is what makes the next chunk
    // sentence-initial: the character AT the cut is the first letter of the opener.
    expect(findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS)).toBe(
      head.length + 2,
    );
    expect(applyFastStyle(text, "default").toLowerCase()).not.toContain(
      "well that worked",
    );
  });

  // The control above puts the terminator 40 characters inside the window, so the cut is
  // the FIRST return of `findSentenceBoundary` and it points past the whitespace run.
  // The second return points AT a separator instead, and it fires when the terminator is
  // the LAST character of the window. That is a real sentence boundary -- the existing
  // test "still takes a real boundary that falls on the window edge" pins that -- but it
  // looks exactly like a whitespace-tier cut if all you check is the character at the cut.
  const withTerminatorOnTheWindowEdge = (opener: string): string => {
    const head = "alpha ".repeat(Math.ceil(FAST_STYLE_MAX_INPUT_CHARS / 6) + 4);
    return `${head.slice(0, FAST_STYLE_MAX_INPUT_CHARS - 1)}. ${opener}${TAIL}`;
  };

  it("puts the terminator on the window edge, where the cut points at the separator", () => {
    // The guard for the test below. If this shape stopped being the `afterSpace >= end`
    // branch, the next test would pass for the wrong reason.
    const text = withTerminatorOnTheWindowEdge("so I went home");
    expect(text[FAST_STYLE_MAX_INPUT_CHARS - 1]).toBe(".");
    expect(text[FAST_STYLE_MAX_INPUT_CHARS]).toBe(" ");
    expect(findChunkCut(text, 0, FAST_STYLE_MAX_INPUT_CHARS)).toBe(
      FAST_STYLE_MAX_INPUT_CHARS,
    );
  });

  for (const tone of [
    "default",
    "email",
    "notes",
    "prompt",
    "concise",
    "chat",
    "formal",
    "bullets",
  ] as const) {
    it(`still deletes the opener the ${tone} tone would delete, behind an edge boundary`, () => {
      // The under-redaction half of the seam. Gating on "the character at the cut is not a
      // space" is right for the whitespace tier and wrong for this one, so an opener
      // behind a real boundary stopped being removed once the input crossed the cap.
      // Measured on this input at `default`: over the cap it came back as
      // "...alpha alpha alpha. So I went home." and under the cap as "Alpha. so I went home."
      // What each tone actually removes at a genuine sentence start, measured rather than
      // assumed. `SO_WELL_LEADING_RE` takes `so`, `well` and `okay` under every tone.
      // Under `prompt`, `PROMPT_OPENER_RE` removes the marker word alone -- `hey there
      // friend` comes back as `there friend` -- and `PROMPT_REQUEST_RE` removes the
      // request framing and keeps the payload. So the probe is the REMOVED part, not the
      // whole opener, and the two `prompt`-only patterns are not asserted on other tones
      // at all.
      const forThisTone =
        tone === "prompt"
          ? [
              ...openers,
              ["hey can you send that file", "hey can you"],
              ["I need you to send that file", "i need you to"],
            ]
          : openers.filter(([opener]) => !/^(Can you|hey)/.test(opener));
      for (const [opener, probe] of forThisTone) {
        const text = withTerminatorOnTheWindowEdge(opener);
        const output = applyFastStyle(text, tone);
        expect(
          output.toLowerCase(),
          `tone=${tone} opener=${opener}`,
        ).not.toContain(probe.toLowerCase());
      }
    });
  }

  // `EXTRA_FILLER_COMMA_RE` is a fourth reader of the same thing, and it is the only one
  // the commit above missed. It is `(?:^|\s)(?:I mean|so|well)\s*,\s*` -- anchored to `^`
  // as one of its two alternatives, applied to the same trimmed chunk, deleting the same
  // connective words -- and it sits inside the very `removeFillerWords` call the gate was
  // added to.
  //
  // Its `\s` alternative also deletes MID-CLAUSE with no seam involved at all, which is a
  // separate defect: `we shipped the build so, the report is ready` becomes `We shipped the
  // build the report is ready.` That is pre-existing and byte-identical at the parent
  // commit, so the tests here scope to the `^` alternative and the mid-clause case is named
  // rather than pinned, because fixing it means changing which of the two alternatives
  // fires -- a different change from gating one on `startsSentence`.
  const commaFilled = [
    ["so, the report is ready", "so,"],
    ["well, the report is ready", "well,"],
    ["I mean, the report is ready", "I mean,"],
  ];

  it("still deletes a comma-filled connective behind an edge boundary", () => {
    // The control for the test below, and it uses the edge seam rather than an under-cap
    // input so the two tests differ only in which tier produced the cut.
    for (const [opener, probe] of commaFilled) {
      const output = applyFastStyle(
        withTerminatorOnTheWindowEdge(opener),
        "default",
      );
      expect(
        output.toLowerCase(),
        `opener=${opener} behind an edge boundary`,
      ).not.toContain(probe.toLowerCase());
    }
  });

  for (const tone of [
    "default",
    "email",
    "notes",
    "prompt",
    "concise",
    "chat",
    "formal",
    "bullets",
  ] as const) {
    it(`keeps a comma-filled connective the ${tone} tone deletes at a real sentence start`, () => {
      for (const [opener, probe] of commaFilled) {
        const output = applyFastStyle(withOpenerAtTheSeam(opener), tone);
        expect(output.toLowerCase(), `tone=${tone} opener=${opener}`).toContain(
          probe.toLowerCase(),
        );
      }
    });
  }
});

describe("over-length dictation keeps every character", () => {
  /** Long enough to need several chunks at the current chunk size. */
  const overCap = (repeats: number) => "dictation word ".repeat(repeats);
  const TAIL = "zztaillowzz";

  it("carries a tail marker past the cap into the output", () => {
    // Sized so the marker sits well beyond one chunk, and the body before it is
    // padded so the marker cannot survive by staying inside the first chunk.
    const body = `${overCap(2000)} ${TAIL}.`;
    expect(body.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    expect(applyFastStyle(body, "default")).toContain(TAIL);
  });

  it("concatenates chunks back to the whole input, dropping nothing", () => {
    // Every numbered token must appear, in order. A dropped tail loses the high
    // numbers; a chunk boundary landing inside a word splits one token into two
    // fragments, so the token itself goes missing and this fails.
    // Token widths grow with the index, so this is sized to clear two full
    // chunks by a wide margin rather than by arithmetic on the token count.
    const tokens = Array.from({ length: 6000 }, (_, i) => `tok${i}`);
    const raw = `${tokens.join(". ")}.`;
    expect(raw.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS * 2);

    // Bullets prefix each line with "- ", so that is removed before matching.
    const flat = applyFastStyle(raw, "bullets")
      .toLowerCase()
      .replaceAll("- ", " ");
    let cursor = 0;
    for (const token of tokens) {
      // Matched without the sentence period, because `toBullets` strips the
      // trailing period off every bullet it emits — including the one that
      // happens to land on a chunk boundary. That is the tone's own behaviour on
      // any input, not text lost to splitting. Bare tokens still match exactly:
      // the cursor only advances past a token already consumed, so the prefix
      // "tok1" cannot stand in for "tok10".
      const at = flat.indexOf(token, cursor);
      expect(
        at,
        `token ${token} missing or out of order`,
      ).toBeGreaterThanOrEqual(cursor);
      cursor = at + token.length;
    }
  });

  it("styles every chunk for every tone that has a local transform", () => {
    // One dispatch bug on any single tone re-introduces the loss for that tone
    // only, so the sweep covers all of them rather than spot-checking `default`.
    const tones = [
      "default",
      "email",
      "chat",
      "formal",
      "prompt",
      "bullets",
      "concise",
      "notes",
    ];
    const body = `${overCap(2000)} The last thing I said was ${TAIL}.`;
    for (const tone of tones) {
      expect(canApplyFastStyle(tone)).toBe(true);
      const out = applyFastStyle(body, tone);
      // `concise` strips filler, `formal` expands contractions, and `prompt`
      // drops its politeness framing, so the marker is matched loosely: it is a
      // run of lowercase letters with no transform that would rewrite it.
      expect(out.toLowerCase(), `tone ${tone} dropped the tail`).toContain(
        TAIL,
      );
    }
  });

  it("reports no truncation, because nothing was truncated", () => {
    const body = `${overCap(2000)} ${TAIL}.`;
    expect(measureFastStyleTruncation(body)).toBeNull();
  });

  it("is byte-identical for input under the chunk size", () => {
    // Pinned to literal expected output, not to a second call: comparing
    // `applyFastStyle(x)` with `applyFastStyle(x)` would pass even if the single
    // chunk path changed completely, which is the regression this guards.
    expect(applyFastStyle("um so I went to the store uh", "default")).toBe(
      "I went to the store.",
    );
    expect(applyFastStyle("I think it is fine.", "concise")).toBe(
      "It is fine.",
    );
    expect(applyFastStyle("I need to buy milk. I need bread.", "bullets")).toBe(
      "- I need to buy milk\n- I need bread",
    );
  });

  it("cuts chunks on a code-point boundary, never inside a surrogate pair", () => {
    // A cut at a fixed index can land between a surrogate pair, and a lone
    // surrogate is not encodable: it decodes to U+FFFD, so the character is
    // silently destroyed. This input has no whitespace at all, so it reaches the
    // code-point tier of the cut rather than the sentence or word tiers, and the
    // one-character prefix puts the chunk boundary between a pair.
    const emoji = "\u{1F600}";
    const raw = `x${emoji.repeat(8000)}`;
    expect(raw.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    // Precondition: the boundary really is between the two units of a pair.
    const boundaryUnit = FAST_STYLE_MAX_INPUT_CHARS - 1;
    const atBoundary = raw.charCodeAt(boundaryUnit);
    expect(atBoundary).toBeGreaterThanOrEqual(0xd800);
    expect(atBoundary).toBeLessThanOrEqual(0xdbff);

    const out = applyFastStyle(raw, "default");
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).not.toContain("\uFFFD");
    // Every emoji survived: the cut dropped nothing.
    expect(out.split(emoji).length - 1).toBe(8000);
  });

  /**
   * `toEmail` lifts a greeting off the front and a sign-off off the back, so it
   * is the one transform carrying state across its input. Chunking without
   * scoping it would lift a mid-dictation "Hi." into a greeting for its chunk
   * and pull a mid-dictation "Thanks." out to the end of it — re-ordering
   * sentences the speaker said in a different order, which is the same class of
   * defect as dropping them.
   *
   * A lift is observable as a blank line, because `joinEmailBlocks` separates
   * greeting, body and closing with one. So the marker must sit at a chunk's
   * first position: a lift moves it to the chunk's own first line, while leaving
   * it in the body keeps it inline with the sentence after it.
   *
   * Sentences are all exactly six characters, so chunk one is precisely
   * `FAST_STYLE_MAX_INPUT_CHARS / 6` of them and the marker can be placed at a
   * known chunk start without hard-coding an offset that a cap change would
   * silently invalidate.
   */
  describe("email section lifting stays scoped to the ends of the dictation", () => {
    const SENTENCE = "AAAA.";
    const CHUNK_STRIDE = SENTENCE.length + 1;

    /** Sentences that fit in one chunk, all of identical width. */
    const perChunk = () =>
      Math.floor(FAST_STYLE_MAX_INPUT_CHARS / CHUNK_STRIDE);

    /**
     * `chunks` dictations of uniform sentences, with `marker` placed at
     * sentence index `at` of the built input. Sentence 0 is the dictation's own
     * opener: it matches neither the greeting nor the closing pattern, so the
     * whole-dictation lift cannot fire on it and be mistaken for the marker this
     * test reads. It is the same width as SENTENCE, so replacing it does not
     * shift every later offset and break the chunk alignment relied on below.
     */
    const build = (marker: string, at: number, chunks: number) => {
      const sentences = Array.from(
        { length: perChunk() * (chunks + 1) },
        () => SENTENCE,
      );
      sentences[0] = "Bbbb.";
      sentences[at] = marker;
      return sentences.join(" ");
    };

    /** Byte offset of sentence `index` in a `build` input. */
    const offsetOf = (index: number) => index * CHUNK_STRIDE;

    it("does not lift a chunk-leading greeting into its own block", () => {
      // The first sentence of the second chunk, so it is first in its chunk and
      // last in neither. That is the position an unscoped greeting lift would
      // wrongly treat as the start of a dictation.
      const raw = build("Hi.", perChunk(), 1);
      expect(raw.indexOf("Hi.")).toBe(offsetOf(perChunk()));
      expect(raw.indexOf("Hi.")).toBeGreaterThanOrEqual(
        FAST_STYLE_MAX_INPUT_CHARS,
      );
      const out = applyFastStyle(raw, "email");
      // The whole-dictation lift must not have fired, so this is the only marker
      // and it is not at the front.
      expect(out.startsWith("Bbbb.")).toBe(true);
      const markerAt = out.indexOf("Hi.");
      expect(markerAt).toBeGreaterThan(0);
      // Inline with the sentence that followed it, not separated by the blank
      // line a lifted greeting block adds.
      expect(out.slice(markerAt, markerAt + "Hi.".length + 2)).toBe("Hi. A");
    });

    // NOTE: there is deliberately no matching test for the closing lift. The
    // scoping flag is kept because lifting a mid-dictation sign-off out of a
    // chunk is wrong on the same grounds as the greeting, but no input was found
    // where it changes the output. Every position of the marker was scanned
    // against an unscoped `liftClosing` and the rendered text was identical or
    // differed only by one character of offset: `joinEmailBlocks` re-joins the
    // closing to the end of the body it was taken from, so lifting a chunk's own
    // last sentence puts it back where it already was. Asserting it here would be
    // a test that cannot fail, which is worse than no test.
  });
});

describe("bullet edge stripping", () => {
  it("drops every whitespace character the punctuation class matches", () => {
    // An earlier version kept an ASCII Set beside the character class and lost
    // every Unicode whitespace character the class matches. Each entry below is
    // in the class, so each must come off both ends.
    const unicodeWhitespace = [
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2009",
      "\u2028",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
      "\f",
      "\v",
    ];
    for (const ws of unicodeWhitespace) {
      expect(stripEdgePunctuation(`${ws}Buy milk${ws}`)).toBe("Buy milk");
    }
  });

  it("still drops the ASCII punctuation and whitespace it always dropped", () => {
    for (const ch of [",", ";", ".", " ", "\t", "\n", "\r"]) {
      expect(stripEdgePunctuation(`${ch}Buy milk${ch}`)).toBe("Buy milk");
      expect(stripEdgePunctuation(`${ch}${ch}Buy milk${ch}${ch}`)).toBe(
        "Buy milk",
      );
    }
  });

  it("keeps characters that are not in the class", () => {
    // A zero width space is not whitespace to the class, so it is content and
    // must survive rather than being eaten.
    expect(stripEdgePunctuation("\u200bBuy milk\u200b")).toBe(
      "\u200bBuy milk\u200b",
    );
  });

  it("leaves clean input untouched", () => {
    expect(stripEdgePunctuation("Buy milk")).toBe("Buy milk");
    expect(stripEdgePunctuation("")).toBe("");
  });
});

describe("an ambiguous contraction is left alone rather than guessed at", () => {
  it("leaves both ambiguous families alone", () => {
    // Two families in CONTRACTION_MAP have two readings and nothing in the sentence
    // to tell them apart. `'d` is *would* in "I'd like" and *had* in "I'd already
    // left"; `'s` is *is* in "it's been" and *has* in "it's been a long day" -- both
    // readings of that one phrase, which is the point.
    //
    //   "i'd already left the office" -> "I would already left the office."
    //   "it's been a long day"        -> "It is been a long day."
    //
    // The module's own rule for a match that might be wrong is the one already written
    // above the map: "failing to expand a typo costs something that still reads
    // correctly, whereas matching a bare word rewrites a sentence the speaker did not
    // say." A contraction that guesses the wrong sense is on the second side of that
    // line. Leaving it unexpanded still reads correctly and cannot mis-state it.
    //
    // Guessing is not available either: it needs a participle lexicon this module
    // deliberately does not carry, and "I'd rather", "I'd better", "I'd love" and "I'd
    // prefer" all take *would*, so a lookahead would have to know that list too.
    for (const input of [
      "i'd already left the office",
      "we'd already shipped it",
      "you'd told me twice",
      "they'd finished by then",
      "i'd seen it before",
      "it's been a long day",
      "there's been a problem",
      "what's been happening",
      "who's been helping",
    ]) {
      expect(applyFastStyle(input, "formal")).toBe(
        `${input[0].toUpperCase()}${input.slice(1)}.`,
      );
    }

    // The unambiguous contractions are untouched by that: one reading each, and the
    // bare-form collisions are handled by requiring the apostrophe.
    for (const [input, expected] of [
      ["we're right", "We are right."],
      ["we'll see", "We will see."],
      ["they're here", "They are here."],
      ["let's go", "Let us go."],
      ["I'll be there", "I will be there."],
    ] as const) {
      expect(applyFastStyle(input, "formal")).toBe(expected);
    }
  });
});

describe("a casual word is rewritten, not deleted", () => {
  it("covers every case in this note", () => {
    // `INFORMAL_RE` matched `gonna|wanna|gotta|kinda|sorta|yeah|yep|nope` and every
    // match was deleted. Deleting is only harmless for a word with nothing to say:
    // `nope` inverts a negation, and the `-in'g` forms left a verb with nothing to
    // attach to once `expandContractions` had already turned "I'm" into "I am".
    //
    //   "nope, the report is correct" -> ", the report is correct."
    //   "im gonna go now"             -> "I am go now."
    //   "i wanna go now"              -> "I go now."
    //   "you gotta be there"          -> "You be there."
    //
    // The first is the worst: `no` IS the formal equivalent of `nope`, so this is not
    // a register change, it is the opposite claim. It also left a leading comma that
    // `fixCapitalizationAndPunctuation` cannot repair: it capitalizes the first
    // character of each sentence, and `capitalizeFirst` leaves a comma alone. That
    // holds at any sentence start, not only at index 0 -- "we shipped it. nope,
    // that is wrong" came back as "We shipped it. , that is wrong."
    for (const [input, expected] of [
      ["nope, the report is correct", "No, the report is correct."],
      ["nope that's right", "No that's right."],
      // Mid-sentence `yeah`, not leading. `SO_WELL_LEADING_RE` strips one at index
      // 0 as a discourse opener, alongside `so` and `well`, and that is deliberate
      // -- but that regex is anchored `^` with no `m` flag and runs once over the
      // whole chunk, so it does NOT strip an opener after a sentence boundary:
      // "we shipped. yeah that works" becomes "We shipped. yes that works." The
      // asymmetry is pre-existing and separate; this case is about the rewrite map,
      // which runs after it.
      ["we shipped yeah", "We shipped yes."],
      ["yep that works", "Yes that works."],
      ["im gonna go now", "I am going to go now."],
      ["i wanna go now", "I want to go now."],
      ["you gotta be there", "You got to be there."],
      ["kinda tired", "Somewhat tired."],
      ["sorta late", "Somewhat late."],
    ] as const) {
      expect(applyFastStyle(input, "formal")).toBe(expected);
    }

    // A deletion that leaves punctuation behind must not survive as a leading comma,
    // whatever caused it. This is the shape the `nope` case produced.
    expect(applyFastStyle("nope, we are done", "formal")).toBe(
      "No, we are done.",
    );

    // Bare `nope` has nothing left to say, so the transform returns a stop rather
    // than an empty string that a caller would have to special-case.
    expect(applyFastStyle("nope", "formal")).toBe("No.");
  });
});

describe("filler removal keeps words that merely end in a filler", () => {
  it("does not eat ordinary words", () => {
    for (const sentence of [
      "I am going to the store",
      "The server returned an error",
      "She is a member of the team",
      "I emailed them yesterday",
      "He came home early",
    ]) {
      expect(applyFastStyle(sentence, "default").toLowerCase()).toBe(
        `${sentence.toLowerCase()}.`,
      );
    }
  });

  it("still removes every spoken filler", () => {
    for (const filler of [
      "um",
      "uh",
      "umm",
      "ummm",
      "hmm",
      "mm",
      "mmm",
      "er",
      "ah",
    ]) {
      const out = applyFastStyle(`${filler} I went to the store`, "default");
      expect(out.toLowerCase()).not.toMatch(new RegExp(`\\b${filler}\\b`));
      expect(out.toLowerCase()).toContain("i went to the store");
    }
  });

  describe("a contraction expansion never fires on a bare word that happens to be one", () => {
    it("covers every case in this note", () => {
      // `contraction.replace("'", "'?")` made the APOSTROPHE optional, so `we're`
      // also matched `were`, `it's` matched `its`, `we'll` matched `well`, `let's`
      // matched `lets`, and `I'll` matched `ill`. Formal mode rewrote ordinary
      // sentences accordingly.
      //
      // It used to name `Id` and `wed` here too. Those two entries were dropped
      // later, for a different reason and in a different commit: `'d` is ambiguous
      // between *would* and *had*, so it is not expanded at all. See "an ambiguous
      // 'd is left alone rather than guessed at" below.
      //
      // It is the apostrophe that becomes optional, not the tail of the stem, so
      // `can't` compiles to `\bcan'?t\b` and never matched a bare `can`. That is
      // pinned below, because it is the one entry in this map where the naive
      // reading of the substitution goes wrong in the safe direction.
      for (const [input, expected] of [
        ["we were ready", "We were ready."],
        ["the dog wagged its tail", "The dog wagged its tail."],
        ["as well as that", "As well as that."],
        ["it is well done", "It is well done."],
        ["he lets go", "He lets go."],
        ["he is ill", "He is ill."],
      ] as const) {
        expect(applyFastStyle(input, "formal")).toBe(expected);
      }

      // `can` is not among them: the `'?` sits between the stem and the final `t`.
      expect(applyFastStyle("we can go now", "formal")).toBe("We can go now.");

      // The five are not the whole map. The other bare forms are not words, so
      // their apostrophe stays optional: speech-to-text drops it, and "dont stop"
      // reading as "Do not stop." is the behaviour worth keeping. Being wrong in
      // that direction costs an unexpanded typo that still reads correctly; being
      // wrong in the other one rewrites the user's sentence.
      expect(applyFastStyle("dont stop", "formal")).toBe("Do not stop.");
      expect(applyFastStyle("cant wait", "formal")).toBe("Cannot wait.");

      // `wont` is the one that is not a plausible typo. `cant wait` and `dont stop`
      // are what speech-to-text produces for `can't wait` and `don't stop`, so
      // accepting the apostrophe-less spelling costs an unexpanded typo at worst.
      // `wont` has no such reading: "he was wont to nod" is ordinary English, and
      // expanding it to "will not" rewrites the sentence the user actually said.
      // So `won't` requires its apostrophe while `won't` still expands.
      expect(applyFastStyle("he was wont to nod", "formal")).toBe(
        "He was wont to nod.",
      );
      expect(applyFastStyle("he won't nod", "formal")).toBe("He will not nod.");

      // And the four still expand when they are genuinely contractions.
      expect(applyFastStyle("we're ready", "formal")).toBe("We are ready.");
      expect(applyFastStyle("we'll go", "formal")).toBe("We will go.");
      expect(applyFastStyle("let's go", "formal")).toBe("Let us go.");
      expect(applyFastStyle("I'll be there", "formal")).toBe(
        "I will be there.",
      );
      expect(applyFastStyle("can't stay", "formal")).toBe("Cannot stay.");
      // The `'d` and `'s` families are not here: both are ambiguous, so neither is
      // expanded at all. See the case above named for ambiguous contractions.
    });
  });

  describe("every semicolon-separated idea becomes its own bullet", () => {
    it("covers every case in this note", () => {
      // The fragment filter was `trimmed.length > 2`, which drops a two-character
      // idea. It read as a guard against emitting empty bullets, but the fallback
      // only applies when EVERY fragment was short, so a single longer sibling was
      // enough to delete the short ones. This module's own header says nothing here
      // may shorten text.
      // Bullets capitalize each item, which is established behaviour below, so the
      // expectations here carry it. The point of each case is which items survive.
      expect(applyFastStyle("Go; no; stop.", "bullets")).toBe(
        "- Go\n- No\n- Stop",
      );
      expect(applyFastStyle("go; no; stop", "bullets")).toBe(
        "- Go\n- No\n- Stop",
      );
      // A digit is an idea too, and "3; 4; 5" is a list of three.
      expect(applyFastStyle("3; 4; 5", "bullets")).toBe("- 3\n- 4\n- 5");

      // The filter exists to keep empty bullets out. A fragment with no letter or
      // digit in it is one.
      //
      // The threshold that was here also dropped both of these, but only as a side
      // effect of counting characters: an em dash survives `stripEdgePunctuation`,
      // which removes only `[,.;\s]`, and `toBullets` strips a leading marker, so a
      // bare hyphen became an empty bullet. A threshold of 1 or less is what would let
      // either through as content. The reason to prefer the letter-or-digit test is
      // that it drops both without also dropping "no" or "3", and it reads as the
      // property being checked rather than as a proxy for it. The control without the
      // empty fragment is the same sentence and shows what these three are compared
      // against.
      expect(applyFastStyle("Buy milk; eggs", "bullets")).toBe(
        "- Buy milk\n- Eggs",
      );
      // One assertion over an object rather than a loop: vitest matchers take a
      // single argument, so a message cannot be attached to `toBe`, and the keys are
      // what name the failing case in the diff.
      const bulletsFor = (empty: string) =>
        applyFastStyle(`Buy milk; ${empty}; eggs`, "bullets");
      expect({
        "a bare hyphen": bulletsFor("-"),
        "nothing at all": bulletsFor(""),
        "an em dash": bulletsFor("\u2014"),
      }).toEqual({
        "a bare hyphen": "- Buy milk\n- Eggs",
        "nothing at all": "- Buy milk\n- Eggs",
        "an em dash": "- Buy milk\n- Eggs",
      });
    });
  });

  describe("a chunk seam is not a sentence boundary", () => {
    // A dictation longer than FAST_STYLE_MAX_INPUT_CHARS is styled chunk by chunk
    // and the chunks are rejoined with no terminator between them, so a chunk that
    // ends mid-sentence must not be given a full stop. It used to be, and the next
    // chunk was capitalized as though a new sentence began there.
    const fragment = "hello ".repeat(2200).trim(); // 13,199 chars, no terminator
    const twoChunks = `${fragment} ${fragment}`; // 26,399, so the chunker splits

    it("splits the input, so this is the case that matters", () => {
      expect(twoChunks.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
      expect(fragment.length).toBeLessThan(FAST_STYLE_MAX_INPUT_CHARS);
    });

    // `email` and `prompt` are here because each appends a terminator of its own
    // rather than going through `ensureSentencePunctuation`: `toEmail` reaches it
    // via `toPolished`, `toPrompt` adds its stop directly. Fixing the shared helper
    // alone left both still adding one at the seam.
    for (const tone of [
      "default",
      "formal",
      "concise",
      "chat",
      "email",
      "prompt",
    ]) {
      it(`adds no terminator at the seam for the ${tone} tone`, () => {
        const out = applyFastStyle(twoChunks, tone);
        // Exactly one period, and it is the one at the very end. This is the
        // assertion that pins the absence of the invented stop; the one below only
        // rules out a capital AFTER a terminator, which cannot see a capital that
        // stands on its own.
        expect(out.match(/\./g) ?? []).toHaveLength(1);
        expect(out.endsWith(".")).toBe(true);
        expect(out.slice(0, -1)).not.toMatch(/[.!?]\s+[A-Z]/);
      });
    }

    // The two tones whose output is one item per line, joined by newlines rather
    // than by a space. A stop at the seam would land inside an item, so they are
    // checked by item count and by the absence of a stop on any non-final item.
    for (const tone of ["bullets", "notes"]) {
      it(`leaves no stop on a non-final item for the ${tone} tone`, () => {
        const out = applyFastStyle(twoChunks, tone);
        const items = out.split("\n").filter((line) => line.trim());
        expect(items.length).toBeGreaterThan(1);
        for (const item of items.slice(0, -1)) {
          expect(item).not.toMatch(/[.!?]$/);
        }
      });
    }

    // `toChat` and `toPrompt` tested for an existing terminator with a bare
    // `[.!?]` while the rest of the module uses `ENDS_SENTENCE_RE`, which also
    // recognises `…`, `。`, `！` and `？`. A dictation already ending in one of those
    // came back with a second, ASCII, stop -- "第一句。." on a CJK sentence.
    for (const tone of ["chat", "prompt"]) {
      it(`adds no second stop after a CJK terminator for the ${tone} tone`, () => {
        for (const [input, expected] of [
          ["第一句。", "第一句。"],
          ["第一句！", "第一句！"],
          ["第一句？", "第一句？"],
          ["等等…", "等等…"],
        ]) {
          expect(applyFastStyle(input, tone)).toBe(expected);
        }
      });
    }

    // The controls. A single chunk is final and still gets its stop, and an input
    // that carries its own terminator is unchanged by any of this.
    it("still terminates a final chunk", () => {
      expect(applyFastStyle("hello world", "default")).toBe("Hello world.");
      expect(
        applyFastStyle(`${fragment}.`, "default").match(/\./g) ?? [],
      ).toHaveLength(1);
    });

    // A real sentence boundary inside the input is not a seam and keeps its stop,
    // so this does not flatten genuine punctuation.
    it("keeps a genuine boundary between chunks", () => {
      const out = applyFastStyle(`${fragment}. ${fragment}.`, "default");
      expect(out.match(/\./g) ?? []).toHaveLength(2);
    });
  });
});

describe("fast style written-form passes", () => {
  it("joins a spoken domain instead of leaving a space before the dot", () => {
    expect(applyFastStyle("go to example dot com", "default")).toBe(
      "Go to example.com.",
    );
    expect(applyFastStyle("our site is mausvoice dot dev", "default")).toBe(
      "Our site is mausvoice.dev.",
    );
  });

  it("joins a spoken email address", () => {
    expect(
      applyFastStyle("send it to mike at example dot com", "default"),
    ).toBe("Send it to mike@example.com.");
    expect(
      applyFastStyle("my email is jane at mausvoice dot com", "default"),
    ).toBe("My email is jane@mausvoice.com.");
  });

  it("does not turn a preposition into an at sign", () => {
    expect(applyFastStyle("look at example.com", "default")).toBe(
      "Look at example.com.",
    );
    expect(applyFastStyle("we met at example.com", "default")).toBe(
      "We met at example.com.",
    );
  });

  it("drops the corrected value before an unpunctuated marker", () => {
    expect(
      applyFastStyle("send the report by friday no wait thursday", "default"),
    ).toBe("Send the report by Thursday.");
    expect(applyFastStyle("order two make that three coffees", "default")).toBe(
      "Order three coffees.",
    );
    expect(applyFastStyle("meet me at three or rather four", "default")).toBe(
      "Meet me at four.",
    );
  });

  it("keeps a literal 'no wait' that is not a correction", () => {
    expect(applyFastStyle("there is no wait at the clinic", "default")).toBe(
      "There is no wait at the clinic.",
    );
  });

  it("writes numbers, times, dates, currency and percent", () => {
    expect(
      applyFastStyle(
        "the budget is two hundred and fifty thousand dollars",
        "default",
      ),
    ).toBe("The budget is $250,000.");
    expect(
      applyFastStyle("ship it on the twenty third of october", "default"),
    ).toBe("Ship it on October 23.");
    expect(applyFastStyle("call me at three thirty pm", "default")).toBe(
      "Call me at 3:30 PM.",
    );
    expect(applyFastStyle("raise it by ten percent", "default")).toBe(
      "Raise it by 10%.",
    );
  });

  it("leaves a year written in words alone", () => {
    expect(applyFastStyle("that was in nineteen eighty four", "default")).toBe(
      "That was in nineteen eighty four.",
    );
  });

  it("applies dictionary casing to a term spelled with different case", () => {
    expect(
      applyFastStyle("mausvoice is the app", "default", {
        dictionaryTerms: ["mausVoice"],
      }),
    ).toBe("mausVoice is the app.");
    expect(
      applyFastStyle("I use github daily", "default", {
        dictionaryTerms: ["GitHub"],
      }),
    ).toBe("I use GitHub daily.");
  });

  it("does not rewrite a dictionary term that is already spelled right", () => {
    expect(
      applyFastStyle("mausVoice is the app", "default", {
        dictionaryTerms: ["mausVoice"],
      }),
    ).toBe("mausVoice is the app.");
  });

  it("counts sentences the way the transforms split them", () => {
    expect(countFastStyleSentences("")).toBe(0);
    expect(countFastStyleSentences("hello there")).toBe(1);
    expect(countFastStyleSentences("hello there. How are you")).toBe(2);
    expect(countFastStyleSentences("one. Two. Three.")).toBe(3);
    // A lowercase word after the stop does not open a new sentence under the
    // transform's own splitter, so it counts as one.
    expect(countFastStyleSentences("hello there. how are you")).toBe(1);
  });
});

describe("fast style written-form guards", () => {
  it("does not invent a domain out of a phrase", () => {
    // The host needs an address frame, so a verb in front of "dot com" is left
    // as it was spoken instead of becoming "use.com".
    expect(applyFastStyle("we use dot com for links", "default")).toBe(
      "We use dot com for links.",
    );
    expect(applyFastStyle("we bought the domain dot com", "default")).toBe(
      "We bought the domain dot com.",
    );
  });

  it("keeps a phrase that merely contains 'dot com'", () => {
    // The domain rule needs a host word, so a determiner in front of "dot" is a
    // phrase and not an address.
    expect(applyFastStyle("the dot com bubble", "default")).toBe(
      "The dot com bubble.",
    );
    expect(applyFastStyle("put it in the dot com folder", "default")).toBe(
      "Put it in the dot com folder.",
    );
  });

  it("keeps a repeated number word whole", () => {
    // "twenty twenty six" is a year and "nine nine nine" is a number; collapsing
    // the repetition first turned them into "26" and "Nine nine".
    expect(applyFastStyle("twenty twenty six was a good year", "default")).toBe(
      "Twenty twenty six was a good year.",
    );
    expect(applyFastStyle("nine nine nine", "default")).toBe("Nine nine nine.");
  });

  it("leaves a marker that opens the dictation in place", () => {
    // There is no value in front of the marker to correct, so nothing may be
    // deleted: this used to come back as "No Thursday."
    expect(applyFastStyle("no wait make that thursday", "default")).toBe(
      "No wait make that Thursday.",
    );
  });

  it("does not delete an apology that reads like a correction", () => {
    expect(applyFastStyle("sorry i meant to call you", "default")).toBe(
      "Sorry i meant to call you.",
    );
  });
});

describe("fast style calendar casing", () => {
  it("capitalizes weekdays and unambiguous month names", () => {
    expect(applyFastStyle("send it by friday", "default")).toBe(
      "Send it by Friday.",
    );
    expect(applyFastStyle("the deadline is in october", "default")).toBe(
      "The deadline is in October.",
    );
  });

  it("leaves month names that are ordinary words alone", () => {
    // "march", "may" and "august" are verbs, a modal and an adjective as often
    // as they are months, so only a date rule may rewrite them.
    expect(applyFastStyle("we march first thing", "concise")).toBe(
      "We march first thing.",
    );
    expect(applyFastStyle("you may want to check", "concise")).toBe(
      "You may want to check.",
    );
  });
});

describe("fast style dictionary casing guards", () => {
  it("leaves an ordinary word alone when a term is its uppercase form", () => {
    // "IT" as a dictionary term must not rewrite every "it".
    expect(
      applyFastStyle("it is working", "default", { dictionaryTerms: ["IT"] }),
    ).toBe("It is working.");
  });

  it("still recases a term that is not an ordinary word", () => {
    expect(
      applyFastStyle("we use postgres daily", "default", {
        dictionaryTerms: ["Postgres"],
      }),
    ).toBe("We use Postgres daily.");
  });
});
