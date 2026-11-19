import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release Cargo lockfiles", () => {
  for (const [path, count] of [
    [".github/workflows/build-desktop.yml", 1],
    [".github/workflows/release.yml", 2],
  ]) {
    it(`passes the locked flag to every Tauri build in ${path}`, () => {
      const commands = [
        ...read(path).matchAll(/^\s*(?:run: )?(pnpm run tauri build[^\n]*)$/gm),
      ].map((match) => match[1]);
      assert.equal(commands.length, count);
      for (const command of commands) {
        assert.match(command, / -- --locked\s*$/);
      }
    });
  }

  it("builds native pill sidecars using their committed lockfiles", () => {
    assert.match(
      read("apps/desktop/scripts/prepare-sidecars.mjs"),
      /const pillCargoArgs = \[\s*"build",\s*"--locked",/,
    );
  });
});
