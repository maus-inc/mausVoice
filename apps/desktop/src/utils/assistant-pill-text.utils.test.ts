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
  });

  it("leaves asterisks glued inside words alone", () => {
    // "is*not*" is not emphasis — no space around the stars.
    expect(markdownToPillText("is*not*true")).toBe("is*not*true");
  });

  it("strips horizontal rules", () => {
    const input = ["A", "---", "B"].join(NL);
    expect(markdownToPillText(input)).toBe("A B");
  });

  it("strips reference links before fence processing", () => {
    expect(markdownToPillText("see [docs]")).toBe("see docs");
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
