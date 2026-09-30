import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Every entry in `dir`, as paths from the repository root.
 *
 * The paths are joined with a forward slash on every platform, the way git
 * writes them, because callers compare them against path literals spelled the
 * same way. Reading one back goes through `readRepoSource`, which resolves it
 * against the repository root with the separator the platform wants.
 */
export const listRepoEntries = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir)).map((name) => `${dir}/${name}`);

/** Every file with `extension` in `dir`, as paths from the repository root. */
export const listRepoSources = (dir: string, extension: string): string[] =>
  listRepoEntries(dir).filter((file) => file.endsWith(extension));

/** Read a file by its path from the repository root. */
export const readRepoSource = (file: string): string =>
  readFileSync(path.join(REPO_ROOT, file), "utf8");

/**
 * Return everything from `marker` to the brace that closes the block it opens.
 *
 * Brace counting starts at the first brace from the start of the marker
 * onward, so a marker may carry the opening brace itself, as a match arm does,
 * and a signature that grows a line break when the code is reformatted still
 * yields the whole block.
 *
 * Throws when the marker is missing, when no block follows it, or when the
 * braces do not balance, so a test that relies on this reports the reason
 * rather than a confusing assertion further down.
 */
/**
 * The body of the first Rust block matching any of `markers`.
 *
 * Several call sites assert a contract against whichever function currently
 * holds the logic — the GTK pill factors it into a helper so it can be tested
 * with an injected send — so a single marker is not always enough.
 */
export const extractRustBlock = (
  source: string,
  ...markers: string[]
): string => {
  const start = markers.reduce<number>((found, marker) => {
    if (found !== -1) {
      return found;
    }
    const index = source.indexOf(marker);
    return index === -1 ? found : index;
  }, -1);
  if (start === -1) {
    throw new Error(`Marker not found in source: ${markers.join(" | ")}`);
  }

  const open = source.indexOf("{", start);
  if (open === -1) {
    throw new Error(`No block follows the marker: ${markers.join(" | ")}`);
  }

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces after the marker: ${markers.join(" | ")}`);
};
