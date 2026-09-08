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
    const input = "<".repeat(50_000) + "text";
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
});
