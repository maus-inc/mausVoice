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
    expect(applySpokenCommands("Hello world scratch that goodbye")).toBe(
      "goodbye",
    );
    expect(applySpokenCommands("First sentence. Second scratch that")).toBe(
      "First sentence.",
    );
    expect(applySpokenCommands("Keep this. Drop that. scratch that")).toBe(
      "Keep this.",
    );
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

  it("does not rewrite English commands for non-English or sentinels", () => {
    expect(applySpokenCommands("hello new line world", "primary")).toBe(
      "hello new line world",
    );
    expect(applySpokenCommands("hello new line world", "auto")).toBe(
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

  it("skips scratch and newlines on interim chunks", () => {
    expect(
      applySpokenCommands("hello new line scratch that", "en", {
        skipStructuralCommands: true,
      }),
    ).toBe("hello new line scratch that");
  });
});
