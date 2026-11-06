import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSourceFiles,
  contractSourceRoots,
} from "./source-tree.test-utils";

describe("source tree contract traversal", () => {
  it("collects application sources and excludes tests and build directories", () => {
    const root = mkdtempSync(join(tmpdir(), "source-tree-"));
    try {
      mkdirSync(join(root, "nested"));
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "__tests__"));
      for (const file of [
        "a.ts",
        "nested/b.tsx",
        "a.test.ts",
        "a.spec.tsx",
        "dist/c.ts",
        "__tests__/d.ts",
      ]) {
        writeFileSync(join(root, file), "");
      }
      expect(
        collectSourceFiles(root)
          .map((file) => file.slice(root.length + 1))
          .sort(),
      ).toEqual(["a.ts", join("nested", "b.tsx")].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds every package source and ignores packages without src", () => {
    const root = mkdtempSync(join(tmpdir(), "source-roots-"));
    try {
      mkdirSync(join(root, "packages", "one", "src"), { recursive: true });
      mkdirSync(join(root, "packages", "two"), { recursive: true });
      const desktop = join(root, "apps", "desktop");
      expect(contractSourceRoots(root, desktop)).toEqual([
        join(desktop, "src"),
        join(root, "packages", "one", "src"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects linked package directories and source roots",
    () => {
      const root = mkdtempSync(join(tmpdir(), "package-root-link-"));
      try {
        const packages = join(root, "packages");
        const target = join(root, "target");
        mkdirSync(packages);
        mkdirSync(target);
        symlinkSync(target, join(packages, "linked"), "dir");
        expect(() => contractSourceRoots(root, root)).toThrow(/symbolic link/i);
        rmSync(join(packages, "linked"));
        mkdirSync(join(packages, "real"));
        symlinkSync(target, join(packages, "real", "src"), "dir");
        expect(() => contractSourceRoots(root, root)).toThrow(/symbolic link/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a source root that is itself a symbolic link",
    () => {
      const root = mkdtempSync(join(tmpdir(), "source-root-link-"));
      try {
        mkdirSync(join(root, "actual"));
        writeFileSync(join(root, "actual", "a.ts"), "");
        symlinkSync(join(root, "actual"), join(root, "linked"), "dir");
        expect(() => collectSourceFiles(join(root, "linked"))).toThrow(
          /symbolic link/i,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on symbolic links rather than following cycles",
    () => {
      const root = mkdtempSync(join(tmpdir(), "source-tree-link-"));
      try {
        symlinkSync(root, join(root, "loop"), "dir");
        expect(() => collectSourceFiles(root)).toThrow(/symbolic link/i);
        expect(() => collectSourceFiles(join(root, "loop"))).toThrow(
          /symbolic link/i,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
