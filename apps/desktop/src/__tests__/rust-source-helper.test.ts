import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  listRepoEntries,
} from "../../test/helpers/rust-source.utils";

/**
 * The contract tests that read Rust source all cut their block out with this
 * helper, so a silent mistake here would weaken every one of them at once.
 */
const SOURCE = [
  "fn before() {}",
  "",
  "pub(crate) fn target(&self) -> bool {",
  "    if self.flag {",
  "        return matches!(self.kind, Kind::A | Kind::B { .. });",
  "    }",
  "    false",
  "}",
  "",
  "fn after() {}",
].join("\n");

describe("extractRustBlock", () => {
  it("returns the whole block, nested braces included", () => {
    const block = extractRustBlock(SOURCE, "pub(crate) fn target(");

    expect(block.startsWith("pub(crate) fn target(&self) -> bool {")).toBe(
      true,
    );
    expect(block).toContain("Kind::B { .. }");
    expect(block.endsWith("}")).toBe(true);
    expect(block).not.toContain("fn after()");
  });

  it("accepts a marker that carries its own opening brace", () => {
    const arm = extractRustBlock(SOURCE, "if self.flag {");

    expect(arm).toContain("return matches!");
    expect(arm).not.toContain("false");
  });

  it("names the marker it could not find", () => {
    expect(() => extractRustBlock(SOURCE, "fn missing(")).toThrow(
      "fn missing(",
    );
  });

  it("reports braces that never close", () => {
    expect(() => extractRustBlock("fn broken() {", "fn broken(")).toThrow(
      "Unbalanced braces",
    );
  });

  it("reports a marker with no block after it", () => {
    expect(() => extractRustBlock("const A: u8 = 1;", "const A")).toThrow(
      "No block follows",
    );
  });
});

describe("listRepoEntries", () => {
  it("returns repository paths with a forward slash on every platform", () => {
    const entries = listRepoEntries("packages/rust_macos_pill/src");

    expect(entries).toContain("packages/rust_macos_pill/src/nsstring.rs");
    expect(entries.filter((entry) => entry.includes("\\"))).toEqual([]);
  });
});
