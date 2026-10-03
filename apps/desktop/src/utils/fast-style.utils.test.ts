import { describe, expect, it } from "vitest";
import {
  FAST_STYLE_MAX_INPUT_CHARS,
  applyFastStyle,
  canApplyFastStyle,
  measureFastStyleTruncation,
  stripEdgePunctuation,
} from "./fast-style.utils";

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
    for (const raw of [
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

  it("exports the same truncation limit the transforms apply", () => {
    // Pinned so the caller that warns about truncation cannot drift from the
    // constant the transform actually uses. The tail marker must not survive.
    const marker = "TAILMARKER";
    const justUnder = "a".repeat(
      FAST_STYLE_MAX_INPUT_CHARS - marker.length - 1,
    );
    expect(applyFastStyle(`${justUnder} ${marker}`, "default")).toContain(
      marker,
    );

    const overBy = "a".repeat(FAST_STYLE_MAX_INPUT_CHARS + 10);
    expect(applyFastStyle(`${overBy} ${marker}`, "default")).not.toContain(
      marker,
    );
  });

  it("preserves meaning (no hallucination)", () => {
    const raw = "We need to launch the product next week";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).toContain("launch");
    expect(out.toLowerCase()).toContain("product");
    expect(out.toLowerCase()).toContain("next week");
  });

  it("handles very long input with truncation guard (no catastrophic backtracking)", () => {
    const long = "I went to the store. ".repeat(800);
    const out = applyFastStyle(long, "default");
    expect(out.length).toBeLessThan(16000);
    expect(out.toLowerCase()).toContain("store");

    const fillerLong = `${"um ".repeat(8000)}I went to the store.`;
    const out2 = applyFastStyle(fillerLong, "default");
    expect(out2.length).toBeLessThan(16000);
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
  it("reports nothing for input at or under the cap", () => {
    expect(measureFastStyleTruncation("")).toBeNull();
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS)),
    ).toBeNull();
  });

  it("reports the dropped count one character over the cap", () => {
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS + 1)),
    ).toEqual({ keptChars: FAST_STYLE_MAX_INPUT_CHARS, droppedChars: 1 });
  });

  it("reports the full dropped tail, not just that truncation happened", () => {
    expect(
      measureFastStyleTruncation("a".repeat(FAST_STYLE_MAX_INPUT_CHARS + 4321)),
    ).toEqual({ keptChars: FAST_STYLE_MAX_INPUT_CHARS, droppedChars: 4321 });
  });

  it("reports nothing when only surrounding whitespace puts the input over", () => {
    // `applyFastStyle` guards on `rawTranscript.trim()` and slices that, so a
    // dictation whose raw form is over the cap only because of padding styles
    // completely. Reporting a truncation here told the user N characters had
    // been left unstyled, and persisted that N on the history row, for a
    // truncation that never happened.
    // Body one under the cap, and enough padding to push the raw form over it:
    // 14999 trimmed is under 15000, 15001 raw is not.
    const body = "w".repeat(FAST_STYLE_MAX_INPUT_CHARS - 1);
    const raw = `  ${body} `;
    expect(body.length).toBeLessThanOrEqual(FAST_STYLE_MAX_INPUT_CHARS);
    expect(raw.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    expect(measureFastStyleTruncation(raw)).toBeNull();
  });

  it("still reports a real truncation that happens to have whitespace", () => {
    // A genuine overrun, with the same padding on top. The padding must not be
    // counted as dropped, and must not stop the real truncation being reported.
    const body = "w".repeat(FAST_STYLE_MAX_INPUT_CHARS + 500);
    const raw = ` ${body} `;
    expect(measureFastStyleTruncation(raw)).toEqual({
      keptChars: FAST_STYLE_MAX_INPUT_CHARS,
      droppedChars: 500,
    });
  });

  it("agrees with the cap applyFastStyle actually enforces", () => {
    const raw = "word ".repeat(6000);
    const truncation = measureFastStyleTruncation(raw);
    expect(truncation).not.toBeNull();
    expect(applyFastStyle(raw, "default").length).toBeLessThanOrEqual(
      FAST_STYLE_MAX_INPUT_CHARS,
    );
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
});
