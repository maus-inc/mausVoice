import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeChangedKeys,
  pruneLocaleFile,
  pruneLocaleDirectory,
} from "./i18n-prune.mjs";

const dirs = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("locale pruning", () => {
  it("identifies added, removed and changed message descriptors", () => {
    const before = {
      same: { defaultMessage: "Same" },
      removed: "Old",
      changed: { defaultMessage: "Old" },
    };
    const after = {
      same: { defaultMessage: "Same" },
      changed: { defaultMessage: "New" },
      added: "New",
    };
    expect(computeChangedKeys(before, after).sort()).toEqual([
      "added",
      "changed",
      "removed",
    ]);
    expect(computeChangedKeys(before, before)).toEqual([]);
  });

  it("removes only stale translations and leaves unchanged files byte-for-byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "locale-prune-"));
    dirs.push(dir);
    const locale = join(dir, "fr.json");
    await writeFile(locale, '{"old":"Ancien","same":"Même"}\n');
    expect(await pruneLocaleFile(locale, ["missing"])).toBe(false);
    expect(await readFile(locale, "utf8")).toBe(
      '{"old":"Ancien","same":"Même"}\n',
    );
    expect(await pruneLocaleFile(locale, ["old", "missing"])).toBe(true);
    expect(JSON.parse(await readFile(locale, "utf8"))).toEqual({
      same: "Même",
    });
  });
  it("prunes matching locale JSON files without altering English or unrelated files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "locale-directory-"));
    dirs.push(dir);
    await writeFile(join(dir, "en.json"), '{"changed":"English"}');
    await writeFile(
      join(dir, "fr.json"),
      '{"changed":"Français","keep":"Bonjour"}',
    );
    await writeFile(join(dir, "de.json"), '{"keep":"Hallo"}');
    await writeFile(join(dir, "notes.txt"), "not JSON");
    expect(await pruneLocaleDirectory(dir, ["changed"])).toEqual(["fr.json"]);
    expect(JSON.parse(await readFile(join(dir, "en.json"), "utf8"))).toEqual({
      changed: "English",
    });
    expect(JSON.parse(await readFile(join(dir, "fr.json"), "utf8"))).toEqual({
      keep: "Bonjour",
    });
    expect(await readFile(join(dir, "de.json"), "utf8")).toBe(
      '{"keep":"Hallo"}',
    );
  });
});
