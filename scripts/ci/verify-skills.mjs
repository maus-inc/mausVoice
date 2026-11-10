#!/usr/bin/env node
/**
 * Skill-vendoring checker — every locked skill tree must match skills-lock.json.
 *
 * `computedHash` is a folder hash in exactly the shape `npx skills` writes: sha256
 * over every file in the skill directory, sorted by relative path, each file's path
 * then its bytes. A file added, edited or dropped after the install breaks it, which
 * is the point: a vendored body stays byte-for-byte as published, so a drift is a
 * finding rather than a stale number. `npx skills add` and `npx skills update` are
 * the only writers of lock entries, so a mismatch is repaired by re-running them or
 * by restoring upstream, never by editing the hash.
 *
 * A second check covers the gap between a passing local run and a failing fresh
 * checkout: a file in a locked tree that a `.gitignore` rule matches is part of the
 * hash on the machine that installed it and absent from every clone. `stageshow`
 * ships a `package-lock.json` and the root ignore rule for that name would have
 * dropped it at `git add`. Such a file is reported as IGNORED and fails the run; the
 * fix is a scoped negation in `.gitignore`, never deleting the file.
 *
 * A skill directory with no lock entry is reported as unrecorded and does not fail:
 * `unslop` and `find-skills` are project-owned on purpose.
 *
 * Usage:
 *   node scripts/ci/verify-skills.mjs            # check every locked skill
 *   node scripts/ci/verify-skills.mjs --strict    # also fail on an unrecorded skill
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function collectFiles(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
    } else if (entry.isFile()) {
      out.push({
        relativePath: relative(root, full),
        content: readFileSync(full),
      });
    }
  }
}

export function listSkillFiles(skillDir) {
  const files = [];
  collectFiles(skillDir, skillDir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export function hashSkillFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

export function computeSkillFolderHash(skillDir) {
  return hashSkillFiles(listSkillFiles(skillDir));
}

/**
 * Paths (relative to `root`) that git would ignore. `--no-index` asks about the
 * rules alone, so an already tracked file still counts: the next `npx skills update`
 * rewrites the tree and the rule bites again on whatever it adds.
 */
export function findIgnoredFiles(root, relativePaths) {
  if (relativePaths.length === 0) return [];
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--no-index", "--stdin", "-z"],
    { input: relativePaths.join("\0") + "\0", encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `git check-ignore failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function verifySkills(
  root,
  { strict = false, log = console.log, error = console.error } = {},
) {
  const skillsDir = join(root, ".agents", "skills");
  const lock = JSON.parse(readFileSync(join(root, "skills-lock.json"), "utf8"));
  const locked = Object.entries(lock.skills ?? {});
  const onDisk = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((name) =>
        statSync(join(skillsDir, name)).isDirectory(),
      )
    : [];

  let drift = 0;
  let checked = 0;

  for (const [name, entry] of locked) {
    const skillDir = join(skillsDir, name);
    if (!existsSync(skillDir)) {
      error(
        `${name}: MISSING  no directory for a locked skill, run \`npx skills update\``,
      );
      drift++;
      continue;
    }
    const files = listSkillFiles(skillDir);
    const actual = hashSkillFiles(files);
    checked++;
    let failed = false;
    if (actual !== entry.computedHash) {
      error(
        `${name}: DRIFT  tree does not match computedHash in skills-lock.json`,
      );
      error(`  expected ${entry.computedHash}`);
      error(`  found    ${actual}`);
      error(
        `  restore upstream, or reinstall with \`npx skills add ${entry.source} -s ${name} -a universal --copy -y\``,
      );
      failed = true;
    }
    const ignored = findIgnoredFiles(
      root,
      files.map((file) => join(relative(root, skillDir), file.relativePath)),
    );
    if (ignored.length > 0) {
      error(
        `${name}: IGNORED  ${ignored.length} file(s) match a .gitignore rule and would be missing from a fresh checkout`,
      );
      for (const path of ignored) error(`  ${path}`);
      error(
        `  add a scoped negation to .gitignore (such as \`!.agents/skills/*/package-lock.json\`); do not delete the file`,
      );
      failed = true;
    }
    if (failed) {
      drift++;
      continue;
    }
    log(`${name}: ok  ${entry.source}`);
  }

  const unrecorded = onDisk.filter((name) => !lock.skills?.[name]);
  if (unrecorded.length > 0) {
    const message = `${unrecorded.join(", ")}: unrecorded  project-owned skills with no lock entry`;
    if (strict) {
      error(message);
      drift++;
    } else {
      log(message);
    }
  }

  log(
    `${checked - drift} of ${locked.length} locked skills verified, ${unrecorded.length} unrecorded${
      strict ? " (strict)" : ""
    }`,
  );
  return drift === 0;
}

export function isDirectInvocation(moduleUrl, scriptPath) {
  return Boolean(scriptPath) && moduleUrl === pathToFileURL(scriptPath).href;
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const ok = verifySkills(ROOT, { strict: process.argv.includes("--strict") });
  process.exit(ok ? 0 : 1);
}
