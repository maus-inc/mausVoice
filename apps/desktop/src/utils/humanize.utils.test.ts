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
