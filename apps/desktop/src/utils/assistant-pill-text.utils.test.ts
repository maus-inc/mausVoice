import { describe, it, expect } from "vitest";
import { markdownToPillText } from "./assistant-pill-text.utils";

const NL = String.fromCharCode(10); // actual newline

describe("markdownToPillText", () => {
  it("handles tilde fences", () => {
    const input = ["~~~", "code", "~~~"].join(NL);
    expect(markdownToPillText(input)).toBe("[code]");
  });

  it("strips bold markers", () => {
    expect(markdownToPillText("hello **world**")).toBe("hello world");
  });

  it("strips italic markers without eating surrounding whitespace", () => {
    expect(markdownToPillText("hello *world* today")).toBe("hello world today");
    expect(markdownToPillText("*lead* and tail")).toBe("lead and tail");
    expect(markdownToPillText("This is *emphasized*.")).toBe(
      "This is emphasized.",
    );
    expect(markdownToPillText("(*emphasized*)")).toBe("(emphasized)");
    expect(markdownToPillText("*emphasized*, next")).toBe("emphasized, next");
  });

  it("leaves asterisks glued inside words alone", () => {
    // "is*not*" is not emphasis — no space around the stars.
    expect(markdownToPillText("is*not*true")).toBe("is*not*true");
  });

  it("strips horizontal rules while preserving line breaks between blocks", () => {
    const input = ["A", "---", "B"].join(NL);
    // The HR line is removed; a single blank line separates the blocks.
    expect(markdownToPillText(input)).toBe(["A", "", "B"].join(NL));
  });

  it("strips reference links before fence processing", () => {
    expect(markdownToPillText("see [docs]")).toBe("see docs");
  });

  it("converts ordered list markers with a manual scanner", () => {
    const input = ["1. first", "2.  second", "  3. third"].join(NL);
    const result = markdownToPillText(input);
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
    expect(result).toContain("3. third");
  });

  it("handles empty input", () => {
    expect(markdownToPillText("")).toBe("");
    expect(markdownToPillText(null)).toBe("");
    expect(markdownToPillText(undefined)).toBe("");
  });

  it("cleans a mixed markdown document", () => {
    const input = [
      "# Welcome",
      "",
      "This is **important** and *emphasized*.",
      "",
      "> A wise quote",
      "",
      "- List item A",
      "- List item B",
      "",
      "```",
      "const x = 1;",
      "```",
    ].join(NL);
    const result = markdownToPillText(input);
    expect(result).not.toContain("**");
    expect(result).not.toContain("```");
    expect(result).toContain("[code]");
    expect(result).toContain("important");
    expect(result).toContain("A wise quote");
    expect(result).toContain("List item");
  });
});

describe("streaming contract", () => {
  it("never emits a raw fence delimiter for a single (partial) call", () => {
    // An unclosed opening fence is reduced to the compact [code] marker rather
    // than leaking raw ``` into the pill mid-stream.
    expect(markdownToPillText(["```js", "const x = 1;"].join(NL))).toBe(
      "[code]",
    );
    expect(markdownToPillText(["~~~", "let y;"].join(NL))).toBe("[code]");
  });

  it("documents that chunk-append is NOT the contract; re-convert accumulated text", () => {
    // The converter is stateless and single-pass, so a marker split across a
    // chunk boundary is not resolved by concatenating per-chunk outputs. The
    // consumer (OverlaySyncSideEffects) re-converts the full accumulated
    // message instead, which is correct.
    const chunk1 = "**bold";
    const chunk2 = " text**";

    const naiveConcat = markdownToPillText(chunk1) + markdownToPillText(chunk2);
    expect(naiveConcat).toContain("**"); // raw markers leak through chunk-append

    expect(markdownToPillText(chunk1 + chunk2)).toBe("bold text");
  });
});

describe("tables and lists stay structured", () => {
  it("renders a GFM table as one line per row with cells joined by pipes", () => {
    const input = [
      "| Name | Score |",
      "| --- | --- |",
      "| Ada | 9 |",
      "| Linus | 10 |",
    ].join(NL);
    const result = markdownToPillText(input);
    expect(result).toContain("Name | Score");
    expect(result).toContain("Ada | 9");
    expect(result).toContain("Linus | 10");
    // The separator row must not leak through.
    expect(result).not.toContain("---");
  });

  it("keeps each bullet on its own line", () => {
    const input = ["- one", "- two", "- three"].join(NL);
    const result = markdownToPillText(input);
    const lines = result.split(NL);
    expect(lines).toEqual(
      expect.arrayContaining(["\u2022 one", "\u2022 two", "\u2022 three"]),
    );
  });
});

describe("unsafe HTML is neutralized", () => {
  it("strips script and other tags without rendering them", () => {
    const input =
      "Safe <script>alert('x')</script> <img src=x onerror=alert(1)> text";
    const result = markdownToPillText(input);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("onerror");
    expect(result).toContain("Safe");
    expect(result).toContain("text");
  });

  it("keeps numeric ranges like <3> and <5 days as literal text", () => {
    // "<" followed by a digit is not an HTML tag (tag names start with a
    // letter). The old scanner treated it as a tag and deleted everything
    // up to the next ">" — "I have <3> apples" became "I have apples".
    expect(markdownToPillText("I have <3> apples")).toBe("I have <3> apples");
    expect(markdownToPillText("Items (<5 days) are old; sort a > b")).toBe(
      "Items (<5 days) are old; sort a > b",
    );
    // A real tag later in the string must still be stripped.
    expect(markdownToPillText("Pick the <2> option <b>now</b>")).toBe(
      "Pick the <2> option now",
    );
  });

  it("decodes entities only after stripping tags so encoded tags stay inert", () => {
    // &lt;script&gt; must not turn back into <script> in the output.
    const input = "Safe &lt;script&gt;alert(1)&lt;/script&gt; text";
    const result = markdownToPillText(input);
    expect(result).not.toContain("<script>");
    expect(result).toContain("Safe");
  });

  it("decodes numeric decimal and hex entities so encoded text does not leak", () => {
    // Numeric entities are common in model output (e.g. en/em dashes) and
    // numeric tag forms must be neutralized too, not re-emitted after the
    // entity pass.
    const input =
      "Em dash &#8212; and hex &#x2014; plus &#60;script&#62;alert(1)&#60;/script&#62;";
    const result = markdownToPillText(input);
    expect(result).toContain("Em dash —");
    expect(result).toContain("hex —");
    expect(result).not.toContain("<script>");
    expect(result).toContain("alert(1)");
  });

  it("handles a long run of opening-angle brackets without backtracking", () => {
    // The tag scanner is single-pass; this would be a worst case for a
    // backtracking regex but must complete immediately.
    const input = `${"<".repeat(50_000)}text`;
    const start = Date.now();
    const result = markdownToPillText(input);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toContain("text");
  });

  it("strips HTML comments and CDATA sections rather than rendering them", () => {
    // Pins the behavior for model-emitted comments/CDATA: the tag content
    // between the opening `<` and the first `>` is removed, so the comment
    // text never leaks into the pill.
    const withComment = "before <!-- internal note --> after";
    expect(markdownToPillText(withComment)).not.toContain("internal note");
    expect(markdownToPillText(withComment)).toContain("before");
    expect(markdownToPillText(withComment)).toContain("after");

    const withCdata = "a <![CDATA[ raw ]]> b";
    expect(markdownToPillText(withCdata)).not.toContain("raw");
  });

  it("preserves HTML-like tags inside inline code as quoted text", () => {
    expect(markdownToPillText("Use `<b>` for bold")).toBe('Use "<b>" for bold');
  });

  // A pill-text clamp that cuts a surrogate pair in half produces a string that
  // is not well-formed. `JSON.stringify` escapes it as `\udXXX`, serde_json
  // rejects that outright, and because the pill crates parse the whole sync as a
  // single `InMessage` -- messages, streaming, permissions and the pending
  // review card together -- one emoji at one offset discarded all of it. The
  // offset that triggers it is not a round number: it is wherever the astral
  // character's lead unit lands exactly on the limit, so the invariant is swept
  // rather than asserted at one input.
  const loneSurrogateAt = (value: string): number => {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit < 0xd800 || unit > 0xdbff) continue;
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return i;
    }
    return -1;
  };

  const cjk = "\u4e2d";
  const tail = "\u5c3e";
  const party = "\u{1f389}";

  it("never leaves a lone surrogate when the clamp lands inside an emoji", () => {
    for (let lead = 560; lead <= 640; lead++) {
      const input = cjk.repeat(lead) + party + tail.repeat(80);
      const out = markdownToPillText(input, { maxLength: 600 });
      expect(loneSurrogateAt(out), `lead offset ${lead}`).toBe(-1);
    }
  });

  it("still clamps and marks the cut when it drops the split emoji", () => {
    // 599 puts the emoji's lead unit exactly on the 600th code unit, so the raw
    // slice ends on it. Pinned rather than left implicit, because this is the
    // one offset in the sweep above that produced the defect.
    const input = cjk.repeat(599) + party + tail.repeat(80);
    const out = markdownToPillText(input, { maxLength: 600 });
    expect(loneSurrogateAt(out)).toBe(-1);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith("\u2026")).toBe(true);
    // The truncated emoji is gone rather than half-present.
    expect(out).not.toContain(party);
  });

  it("keeps an emoji that fits inside the clamp intact", () => {
    // The guard drops a trailing lead unit, never a whole pair, so text that
    // fits must come through byte-identical.
    const input = `${cjk.repeat(10)} ${party} ${tail.repeat(10)}`;
    expect(markdownToPillText(input, { maxLength: 600 })).toBe(input);
  });

  it("would fail without the guard, so the sweep is not vacuous", () => {
    const raw = (cjk.repeat(599) + party + tail.repeat(80)).slice(0, 600);
    expect(loneSurrogateAt(raw)).toBe(599);
    // And it is exactly the shape serde_json refuses: an unpaired escape.
    expect(JSON.stringify({ text: raw })).toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("drops exactly one code unit, not a character", () => {
    // The guard must remove only the unpaired lead. Dropping two units would
    // silently swallow a real character on every input that triggers it, which
    // is the failure a lone-surrogate check is supposed to make impossible --
    // and an earlier version of this test did not notice, because its inputs
    // never ended in a lead surrogate with a real character in front of it.
    // 599 CJK puts the emoji's LEAD unit on the 600th code unit, which is what
    // makes the guard fire at all: with 598 the slice ends on the low surrogate,
    // the string is already well-formed, and the guard correctly does nothing --
    // so an over-eager one that fired there would go unnoticed by this test.
    const prefix = cjk.repeat(599);
    const input = `${prefix}${party}${tail.repeat(80)}`;
    const out = markdownToPillText(input, { maxLength: 600 });
    expect(loneSurrogateAt(out)).toBe(-1);
    // Exactly the unpaired lead goes: 599 CJK then the ellipsis. Dropping two
    // units would swallow the 599th character as well, and this asserts that.
    expect(out).toBe(`${prefix}\u2026`);
  });
});
