import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

/**
 * Helpers for the contract tests that read Rust source.
 *
 * Several behaviours have to hold in the same way in three native pill crates
 * and in the desktop bridge, and none of them can be exercised from a unit
 * test here because there is no Rust toolchain in this suite. These tests read
 * the source instead, so they need one way to find a file and one way to cut a
 * block out of it.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** The three native pill crates, one per platform. */
export const PILL_CRATES = [
  { platform: "windows", crate: "packages/rust_windows_pill" },
  { platform: "macos", crate: "packages/rust_macos_pill" },
  { platform: "gtk", crate: "packages/rust_gtk_pill" },
];

/** Read a file by its path from the repository root. */
export const readRepoSource = (file: string): string =>
  readFileSync(path.join(REPO_ROOT, file), "utf8");

/**
 * Return everything from `marker` to the brace that closes the block it opens.
 *
 * Counting starts at the first brace after the marker rather than at the
 * marker itself, so a marker that carries braces of its own, or that grows
 * some when the code is reformatted, still yields the whole block.
 */
export const extractRustBlock = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);

  const open = source.indexOf("{", start);
  expect(open, `no block after ${marker}`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces after ${marker}`);
};
