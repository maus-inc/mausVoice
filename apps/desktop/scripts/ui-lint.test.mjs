import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanUiSource, scanUiTree } from "./ui-lint-rules.mjs";

describe("UI guardrails", () => {
  it("reports each source convention with its path and honors the palette exception", () => {
    expect(
      scanUiSource(
        "component.tsx",
        `transition: "all 0.2s"; color: "#1B8AF8"; borderRadius: "4px"; date.format("MMM D")`,
      ),
    ).toEqual([
      "component.tsx: transition: all",
      "component.tsx: leftover hue-blue #1B8AF8",
      "component.tsx: pixel borderRadius literal",
      "component.tsx: dayjs display format string",
    ]);
    expect(scanUiSource("styles/palette.ts", `color: "#1b8af8"`)).toEqual([]);
    expect(
      scanUiSource("component.tsx", `transition: "allow-discrete"`),
    ).toEqual([]);
  });

  it("walks applicable source files without reading tests, unrelated files, or symlink cycles", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-lint-"));
    try {
      mkdirSync(join(root, "nested"));
      mkdirSync(join(root, "__tests__"));
      writeFileSync(join(root, "nested", "bad.css"), "transition: all 0.2s;");
      writeFileSync(join(root, "__tests__", "ignored.ts"), "transition: all;");
      writeFileSync(join(root, "ignored.md"), "transition: all;");
      symlinkSync(
        root,
        join(root, "nested", "cycle"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(scanUiTree(root).sort()).toEqual([
        "nested/bad.css: transition: all",
        "nested/cycle: symbolic links are not supported in UI source",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
