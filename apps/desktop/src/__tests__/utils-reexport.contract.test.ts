import { describe, expect, it } from "vitest";

import {
  listRepoSourcesRecursive,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: every `crate::utils::<name>` path in the desktop crate resolves.
 *
 * `platform/windows/*` and `platform/macos/*` are `cfg`-gated, so a Linux build
 * never compiles them. `cargo clippy --all-targets` therefore exits 0 without
 * having looked, and a helper that is defined in `utils/strings.rs` but missing
 * from `utils/mod.rs`'s re-exports is a compile error on exactly the two targets
 * a Linux check cannot reach. That is not hypothetical: `truncate_display` was
 * added with four such callers and no re-export, and only the Windows and macOS
 * runners could have caught it.
 *
 * This reads the same way CI does and needs no compilation, so the class is
 * caught here instead of on a platform I cannot run.
 */
const UTILS_MOD = "apps/desktop/src-tauri/src/utils/mod.rs";
const SRC_ROOT = "apps/desktop/src-tauri/src";

/** Names `utils/mod.rs` makes reachable as `crate::utils::<name>`. */
const exportedNames = (): Set<string> => {
  const source = readRepoSource(UTILS_MOD);
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*pub\s+mod\s+(\w+)\s*[;{]/gm)) {
    names.add(match[1]);
  }
  // `pub use foo::bar;` and `pub use foo::{bar, baz};` both land here.
  for (const match of source.matchAll(/^\s*pub\s+use\s+[^;]+;/gm)) {
    const statement = match[0];
    const braced = statement.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
      continue;
    }
    const leaf = statement.replace(/^\s*pub\s+use\s+/, "").replace(/;\s*$/, "");
    const segments = leaf.split("::");
    const name = segments[segments.length - 1].trim();
    if (name) names.add(name);
  }
  return names;
};

describe("crate::utils path resolution", () => {
  it("re-exports every helper its callers reach through the module", () => {
    const exported = exportedNames();
    const used = new Map<string, string[]>();

    for (const file of listRepoSourcesRecursive(SRC_ROOT, ".rs")) {
      const source = readRepoSource(file);
      for (const match of source.matchAll(/crate::utils::(\w+)/g)) {
        const name = match[1];
        used.set(name, [...(used.get(name) ?? []), file]);
      }
    }

    expect(used.size).toBeGreaterThan(0);
    const missing = [...used.entries()]
      .filter(([name]) => !exported.has(name))
      .map(([name, files]) => `${name} (used by ${files.join(", ")})`)
      .sort();
    expect(
      missing,
      `these resolve to nothing, and only the Windows and macOS builds compile the callers:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("finds the names it is meant to police, so an empty pass means nothing", () => {
    // Without this, a regex that silently stops matching turns the contract
    // above into a green no-op -- the same failure mode as an assertion that
    // cannot fail. It is the check I would otherwise have had to take on trust.
    const exported = exportedNames();
    expect(exported.has("truncate_chars")).toBe(true);
    expect(exported.has("decode_to_utf8")).toBe(true);
    // Both are reachable as modules, not just re-exports.
    expect(exported.has("log_sanitizer")).toBe(true);
  });
});
