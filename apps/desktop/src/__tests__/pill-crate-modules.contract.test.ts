import { describe, expect, it } from "vitest";

import {
  PILL_CRATES,
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
 */
const ROOT_FILES = ["lib.rs", "main.rs"];

const fileName = (file: string): string =>
  file.slice(file.lastIndexOf("/") + 1);

const declaresModule = (source: string, module: string): boolean =>
  new RegExp(`^\\s*(pub(\\([^)]*\\))?\\s+)?mod ${module};`, "m").test(source);

describe("native pill crate modules", () => {
  it.each(PILL_CRATES)(
    "$platform declares every module it ships",
    ({ crate }) => {
      const files = listRepoSources(`${crate}/src`, ".rs");
      const roots = files.filter((file) => ROOT_FILES.includes(fileName(file)));
      const modules = files
        .filter((file) => !ROOT_FILES.includes(fileName(file)))
        .map((file) => fileName(file).replace(/\.rs$/, ""));

      expect(roots.length).toBeGreaterThan(0);
      expect(modules.length).toBeGreaterThan(0);

      for (const root of roots) {
        const source = readRepoSource(root);
        const missing = modules.filter(
          (module) => !declaresModule(source, module),
        );

        expect({ root, missing }).toEqual({ root, missing: [] });
      }
    },
  );
});
