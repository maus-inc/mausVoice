import { describe, it, expect } from "vitest";
import { humanizeScrub } from "./humanize.utils";

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
