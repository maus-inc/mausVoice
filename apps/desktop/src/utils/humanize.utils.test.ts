import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { HUMANIZE_SKILL_TEXT, humanizeScrub } from "./humanize.utils";

describe("HUMANIZE_SKILL_TEXT", () => {
  it("stays byte-for-byte synchronized with the standalone prompt artifact", () => {
    const promptArtifact = readFileSync(
      new URL("../../../../scripts/prompts/humanize.txt", import.meta.url),
      "utf8",
    );
    const startMarker = "## Runtime skill (verbatim)";
    const endMarker = "## Expanded guidance";
    const start = promptArtifact.indexOf(startMarker);
    const end = promptArtifact.indexOf(endMarker);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const standalonePrompt = promptArtifact
      .slice(start + startMarker.length, end)
      .trim();
    expect(standalonePrompt).toBe(HUMANIZE_SKILL_TEXT);
  });
});

describe("humanizeScrub", () => {
  it("replaces em-dashes with commas", () => {
    expect(humanizeScrub("foo — bar")).toBe("foo, bar");
  });

  it("replaces 'delve' with 'explore'", () => {
    expect(humanizeScrub("let's delve into")).toBe("let's explore into");
  });

  it("replaces 'seamless' with 'smooth'", () => {
    expect(humanizeScrub("a seamless experience")).toBe("a smooth experience");
  });

  it("replaces 'unlock' with 'enable'", () => {
    expect(humanizeScrub("unlock your potential")).toBe(
      "enable your potential",
    );
  });

  it("replaces 'leveraging' with 'using'", () => {
    expect(humanizeScrub("leveraging AI")).toBe("using AI");
  });

  it("replaces 'utilize' with 'use'", () => {
    expect(humanizeScrub("utilize the tool")).toBe("use the tool");
  });

  it("replaces 'in order to' with 'to'", () => {
    expect(humanizeScrub("in order to work")).toBe("to work");
  });

  it("replaces 'a wide range of' with 'many'", () => {
    expect(humanizeScrub("a wide range of options")).toBe("many options");
  });

  it("removes verbose hedges", () => {
    expect(humanizeScrub("it is important to note that this works")).toContain(
      "this works",
    );
  });

  it("handles null/undefined input", () => {
    expect(humanizeScrub(null)).toBe("");
    expect(humanizeScrub(undefined)).toBe("");
    expect(humanizeScrub("")).toBe("");
  });

  it("normalizes whitespace", () => {
    const result = humanizeScrub("hello   world");
    expect(result).toBe("hello world");
  });

  it("applies multiple replacements", () => {
    const input =
      "It is important to note that leveraging cutting-edge AI will unlock a seamless experience — truly.";
    const result = humanizeScrub(input);
    expect(result).not.toContain("it is important to note that");
    expect(result).not.toContain("leveraging");
    expect(result).not.toContain("cutting-edge");
    expect(result).not.toContain("unlock");
    expect(result).not.toContain("seamless");
    expect(result).not.toContain("—");
  });

  it("does not alter clean text", () => {
    const input = "Hello world. This is fine text.";
    expect(humanizeScrub(input)).toBe(input);
  });
});

describe("humanizeScrub structure preservation", () => {
  it("leaves fenced code blocks byte-for-byte intact", () => {
    const code = [
      "```ts",
      "// unlock the mutex",
      "const ok = lock.unlock();  // keep  double   spaces",
      "",
      'const data = { "unlock": true };',
      "```",
    ].join("\n");
    const input = `Here is the fix:\n\n${code}\n\nDone.`;
    const result = humanizeScrub(input);
    expect(result).toContain(code);
    // Prose around the fence is still scrubbed.
    expect(result).not.toContain("\n\n\n");
  });

  it("leaves inline code spans intact while scrubbing surrounding prose", () => {
    const result = humanizeScrub(
      "Call `lock.unlock()` to unlock the semaphore — carefully.",
    );
    expect(result).toContain("`lock.unlock()`");
    expect(result).not.toContain("—");
    expect(result).toContain("to enable the semaphore");
  });

  it("preserves indentation and blank lines in fenced JSON", () => {
    const json = '{\n  "delve": 1,\n\n  "nested": {\n    "a": 2\n  }\n}';
    const result = humanizeScrub(`Response:\n\n\`\`\`json\n${json}\n\`\`\``);
    expect(result).toContain(json);
  });

  it("keeps paragraph breaks in plain prose", () => {
    const result = humanizeScrub("First paragraph.\n\nSecond paragraph.");
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("collapses horizontal runs but never newlines", () => {
    expect(humanizeScrub("hello   world\n\nnext   line")).toBe(
      "hello world\n\nnext line",
    );
  });

  it("preserves an unterminated fence as code to end of text", () => {
    const input = "Intro sentence.\n\n```\nunlock everything — as-is\n";
    expect(humanizeScrub(input)).toContain("unlock everything — as-is");
  });

  it("keeps fence-looking lines with info strings protected inside a block", () => {
    // A line like ```python inside an open fence is content, not a closing
    // fence: closing fences cannot carry info strings (CommonMark), and
    // splitting there would scrub the block interior as prose.
    const block = [
      "```",
      "An example fence starts with an info string:",
      "```python",
      "lock.unlock()    # keep   spacing",
      "```",
    ].join("\n");
    const input = `Use this:\n\n${block}\n\nDone.`;
    expect(humanizeScrub(input)).toBe(input);
  });

  it("keeps byte-identical structure across alternating prose and fences", () => {
    const input = [
      "First delve into prose.",
      "",
      "```ts",
      "const seamless = true;  // stay untouched",
      "```",
      "",
      "Then utilize this.",
    ].join("\n");
    expect(humanizeScrub(input)).toBe(
      [
        "First explore into prose.",
        "",
        "```ts",
        "const seamless = true;  // stay untouched",
        "```",
        "",
        "Then use this.",
      ].join("\n"),
    );
  });

  it("keeps prose punctuation structure across fence boundaries", () => {
    const input =
      "a seamless thing\n```\ncode — stays\n```\nanother delve plan";
    expect(humanizeScrub(input)).toBe(
      "a smooth thing\n```\ncode — stays\n```\nanother explore plan",
    );
  });

  it("closes fenced blocks under CRLF line endings", () => {
    const prose = "delve into this";
    const input = `Intro.\r\n\r\n\`\`\`ts\r\nconst a = 1;\r\n\`\`\`\r\n\r\n${prose}`;
    const result = humanizeScrub(input);
    // Post-fence prose must still be scrubbed, and the structure must not
    // collapse from fail-closed protection of the whole document.
    expect(result).toContain("const a = 1;");
    expect(result.endsWith("explore into this")).toBe(true);
  });

  it("preserves leading indentation (indented code blocks survive)", () => {
    expect(humanizeScrub("Intro:\n    indented code or list item")).toBe(
      "Intro:\n    indented code or list item",
    );
  });

  it("never merges prose across a newline through the em-dash rule", () => {
    expect(humanizeScrub("Intro —\n- bullet")).toBe("Intro,\n- bullet");
  });

  it("scrubs prose on both sides of a fenced block", () => {
    const input = "delve in\n\n```\ncode — stays\n```\n\nutilize this";
    const result = humanizeScrub(input);
    expect(result.startsWith("explore in")).toBe(true);
    expect(result).toContain("code — stays");
    expect(result.endsWith("use this")).toBe(true);
  });
});

describe("humanizeScrub slop-word variants", () => {
  it("handles 'utilize' inflections case-insensitively", () => {
    expect(humanizeScrub("Utilizes the tool")).toBe("uses the tool");
    expect(humanizeScrub("UTILIZED the tool")).toBe("used the tool");
    expect(humanizeScrub("utilizing the tool")).toBe("using the tool");
    expect(humanizeScrub("Utilize the tool")).toBe("use the tool");
  });

  it("leaves en-dashes (range separators) untouched", () => {
    // En-dash (U+2013) is a legitimate range/compound separator, not AI slop.
    expect(humanizeScrub("1–3 sentences")).toBe("1–3 sentences");
  });
});
