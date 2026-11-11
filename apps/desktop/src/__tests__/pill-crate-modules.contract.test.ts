import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PILL_CRATES,
  listRepoEntries,
  listRepoSources,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: every module file in a native pill crate is declared in every root
 * of that crate.
 *
 * The macOS crate builds twice, once as the library the desktop app embeds and
 * once as the standalone binary, and each root lists the modules of its own
 * build. A module file added to only one of them compiles on one target and
 * fails on the other, which is a break the Rust-free test suite here would
 * otherwise never see.
 *
 * All three crates keep every module in a single file next to the crate root.
 * The first test below fails if that ever stops being true, because a module
 * held in a directory would be invisible to the second one.
 */
const ROOT_FILES = ["lib.rs", "main.rs"];

const DECLARATION = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*);/;

const moduleName = (file: string): string =>
  path.basename(file).replace(/\.rs$/, "");

const declaredModules = (source: string): string[] =>
  source.split("\n").flatMap((line) => DECLARATION.exec(line)?.[1] ?? []);

describe("native pill crate modules", () => {
  it.each(PILL_CRATES)(
    "$platform keeps every module in one file",
    ({ crate }) => {
      const strays = listRepoEntries(`${crate}/src`).filter(
        (entry) => !entry.endsWith(".rs"),
      );

      expect(strays).toEqual([]);
    },
  );

  it.each(PILL_CRATES)(
    "$platform declares every module it ships",
    ({ crate }) => {
      const files = listRepoSources(`${crate}/src`, ".rs");
      const roots = files.filter((file) =>
        ROOT_FILES.includes(path.basename(file)),
      );
      const modules = files
        .filter((file) => !ROOT_FILES.includes(path.basename(file)))
        .map(moduleName);

      expect(roots.length).toBeGreaterThan(0);
      expect(modules.length).toBeGreaterThan(0);

      for (const root of roots) {
        const declared = declaredModules(readRepoSource(root));
        const missing = modules.filter((module) => !declared.includes(module));

        expect({ root, missing }).toEqual({ root, missing: [] });
      }
    },
  );
});
