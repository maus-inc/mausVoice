import { describe, expect, it } from "vitest";
import { markdownToPillText } from "./assistant-pill-text.utils";

/**
 * The native pill cannot render markdown; it receives a flattened plain-text
 * rendering from markdownToPillText. These tests pin the structural contract
 * so that content shown on the pill stays readable and consistent with how
 * the main app (react-markdown + remark-gfm) interprets the same source:
 *  - GFM tables collapse to "cell | cell" rows
 *  - list items / headings stay on their own lines
 *  - raw/encoded HTML tags never leak through
 */
describe("markdownToPillText parity with the main-app GFM renderer", () => {
  it("renders a GFM table as pipe-separated rows (no separator dash row)", () => {
    const md = [
      "| Name | Score |",
      "| --- | --- |",
      "| Ada | 10 |",
      "| Linus | 9 |",
    ].join("\n");
    const text = markdownToPillText(md);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    expect(lines[0]).toBe("Name | Score");
    expect(lines).toContain("Ada | 10");
    expect(lines).toContain("Linus | 9");
    // The markdown alignment row (|---|---|) must not appear as text.
    expect(lines.some((l) => l.includes("---"))).toBe(false);
  });

  it("keeps block structure across headings and lists", () => {
    const md = [
      "# Heading",
      "",
      "- first",
      "- second",
      "",
      "A paragraph.",
    ].join("\n");
    const text = markdownToPillText(md);

    expect(text).toContain("Heading");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("A paragraph.");
    // Each item/heading is on its own line (not concatenated into one word).
    expect(
      text.split("\n").filter((l) => l.trim().length > 0).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("strips both raw and entity-encoded HTML tags", () => {
    const md = "safe <script>evil()</script> &lt;b&gt;bold&lt;/b&gt; done";
    const text = markdownToPillText(md);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<b>");
    expect(text).toContain("safe");
    expect(text).toContain("done");
  });
});
