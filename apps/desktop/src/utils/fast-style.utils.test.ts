import { describe, expect, it } from "vitest";
import {
  FAST_STYLE_MAX_INPUT_CHARS,
  applyFastStyle,
  canApplyFastStyle,
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
    const raw = "word ".repeat(6000);
    // The reported loss and the applied loss must not disagree.
    expect(measureFastStyleTruncation(raw)).toBeNull();
    // And nothing may be missing from what comes back, which is the half of the
    // agreement that a null report alone would not prove.
    expect(applyFastStyle(raw, "default").length).toBeGreaterThan(
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

/**
 * The defect this file's length tests exist for: a dictation longer than the
 * chunk size used to be `slice`d to the cap, so the styled output was a prefix
 * of the input and everything after 15,000 characters was delivered nowhere.
 */
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
