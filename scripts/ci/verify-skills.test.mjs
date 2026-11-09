import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  computeSkillFolderHash,
  findIgnoredFiles,
  verifySkills,
} from "./verify-skills.mjs";

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeSkill(root, name, files) {
  const dir = join(root, ".agents", "skills", name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function writeLock(root, skills) {
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({ version: 1, skills }, null, 2),
  );
}

function run(root, options = {}) {
  const out = [];
  const err = [];
  const ok = verifySkills(root, {
    ...options,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { ok, out: out.join("\n"), err: err.join("\n") };
}

describe("verify-skills", () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "verify-skills-"));
    git(root, "init", "-q");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hashes every file by sorted relative path then bytes", () => {
    const dir = writeSkill(root, "hashed", {
      "SKILL.md": "# a\n",
      "references/b.md": "b\n",
    });
    const first = computeSkillFolderHash(dir);
    writeFileSync(join(dir, "references", "b.md"), "changed\n");
    assert.notEqual(computeSkillFolderHash(dir), first);
    writeFileSync(join(dir, "references", "b.md"), "b\n");
    assert.equal(computeSkillFolderHash(dir), first);
    writeFileSync(join(dir, "node_modules.txt"), "");
    assert.notEqual(
      computeSkillFolderHash(dir),
      first,
      "an extra file changes the hash",
    );
    rmSync(dir, { recursive: true });
  });

  it("passes a tree that matches its lock entry and is not ignored", () => {
    writeFileSync(join(root, ".gitignore"), "");
    const dir = writeSkill(root, "clean", { "SKILL.md": "# clean\n" });
    writeLock(root, {
      clean: { source: "o/r", computedHash: computeSkillFolderHash(dir) },
    });
    const result = run(root);
    assert.equal(result.ok, true, result.err);
    assert.match(result.out, /^clean: ok  o\/r$/m);
    assert.match(result.out, /1 of 1 locked skills verified, 0 unrecorded/);
    rmSync(dir, { recursive: true });
  });

  it("reports DRIFT with both hashes when the tree changed", () => {
    writeFileSync(join(root, ".gitignore"), "");
    const dir = writeSkill(root, "drifted", { "SKILL.md": "# v1\n" });
    writeLock(root, {
      drifted: { source: "o/r", computedHash: computeSkillFolderHash(dir) },
    });
    writeFileSync(join(dir, "SKILL.md"), "# v2\n");
    const result = run(root);
    assert.equal(result.ok, false);
    assert.match(result.err, /^drifted: DRIFT/m);
    assert.match(result.err, /expected [0-9a-f]{64}/);
    assert.match(result.err, /found    [0-9a-f]{64}/);
    assert.match(
      result.err,
      /npx skills add o\/r -s drifted -a universal --copy -y/,
    );
    rmSync(dir, { recursive: true });
  });

  it("reports MISSING for a locked skill with no directory", () => {
    writeLock(root, { ghost: { source: "o/r", computedHash: "0".repeat(64) } });
    const result = run(root);
    assert.equal(result.ok, false);
    assert.match(result.err, /^ghost: MISSING/m);
  });

  it("fails on a file a .gitignore rule would drop, and passes once it is negated", () => {
    const dir = writeSkill(root, "locked", {
      "SKILL.md": "# locked\n",
      "package-lock.json": "{}\n",
    });
    writeLock(root, {
      locked: { source: "o/r", computedHash: computeSkillFolderHash(dir) },
    });

    writeFileSync(join(root, ".gitignore"), "package-lock.json\n");
    const failing = run(root);
    assert.equal(failing.ok, false);
    assert.match(failing.err, /^locked: IGNORED  1 file\(s\)/m);
    assert.match(
      failing.err,
      /^  \.agents\/skills\/locked\/package-lock\.json$/m,
    );
    assert.match(failing.err, /scoped negation/);
    assert.doesNotMatch(failing.err, /DRIFT/, "the hash itself is fine");

    writeFileSync(
      join(root, ".gitignore"),
      "package-lock.json\n!.agents/skills/*/package-lock.json\n",
    );
    const passing = run(root);
    assert.equal(passing.ok, true, passing.err);
    assert.match(passing.out, /^locked: ok/m);
    rmSync(dir, { recursive: true });
  });

  it("still flags an ignored file after it has been committed", () => {
    const dir = writeSkill(root, "tracked", {
      "SKILL.md": "# tracked\n",
      "debug.log": "",
    });
    writeLock(root, {
      tracked: { source: "o/r", computedHash: computeSkillFolderHash(dir) },
    });
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    git(root, "add", "-f", ".agents/skills/tracked/debug.log");
    const result = run(root);
    assert.equal(result.ok, false);
    assert.match(result.err, /^tracked: IGNORED/m);
    assert.match(result.err, /debug\.log/);
    git(root, "rm", "-q", "--cached", ".agents/skills/tracked/debug.log");
    rmSync(dir, { recursive: true });
  });

  it("treats unrecorded directories as a note, and as a failure under --strict", () => {
    writeFileSync(join(root, ".gitignore"), "");
    const dir = writeSkill(root, "owned", { "SKILL.md": "# owned\n" });
    writeLock(root, {});
    const lenient = run(root);
    assert.equal(lenient.ok, true);
    assert.match(lenient.out, /^owned: unrecorded/m);
    const strict = run(root, { strict: true });
    assert.equal(strict.ok, false);
    assert.match(strict.err, /^owned: unrecorded/m);
    assert.match(strict.out, /\(strict\)/);
    rmSync(dir, { recursive: true });
  });

  it("findIgnoredFiles returns nothing for an empty list without calling git", () => {
    assert.deepEqual(findIgnoredFiles("/nonexistent", []), []);
  });
});
