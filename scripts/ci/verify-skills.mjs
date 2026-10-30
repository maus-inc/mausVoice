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
 * A skill directory with no lock entry is reported as unrecorded and does not fail:
 * `unslop` and `find-skills` are project-owned on purpose.
 *
 * Usage:
 *   node scripts/ci/verify-skills.mjs            # check every locked skill
 *   node scripts/ci/verify-skills.mjs --strict    # also fail on an unrecorded skill
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SKILLS_DIR = join(ROOT, ".agents", "skills")
const LOCK_FILE = join(ROOT, "skills-lock.json")

function collectFiles(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(root, full, out)
    } else if (entry.isFile()) {
      out.push({ relativePath: relative(root, full), content: readFileSync(full) })
    }
  }
}

function computeSkillFolderHash(skillDir) {
  const files = []
  collectFiles(skillDir, skillDir, files)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update(file.content)
  }
  return hash.digest("hex")
}

const strict = process.argv.includes("--strict")
const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"))
const locked = Object.entries(lock.skills ?? {})
const onDisk = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR).filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
  : []

let drift = 0
let checked = 0

for (const [name, entry] of locked) {
  const skillDir = join(SKILLS_DIR, name)
  if (!existsSync(skillDir)) {
    console.error(`${name}: MISSING  no directory for a locked skill, run \`npx skills update\``)
    drift++
    continue
  }
  const actual = computeSkillFolderHash(skillDir)
  checked++
  if (actual === entry.computedHash) {
    console.log(`${name}: ok  ${entry.source}`)
    continue
  }
  console.error(`${name}: DRIFT  tree does not match computedHash in skills-lock.json`)
  console.error(`  expected ${entry.computedHash}`)
  console.error(`  found    ${actual}`)
  console.error(
    `  restore upstream, or reinstall with \`npx skills add ${entry.source} -s ${name} -a universal --copy -y\``,
  )
  drift++
}

const unrecorded = onDisk.filter((name) => !lock.skills?.[name])
if (unrecorded.length > 0) {
  const message = `${unrecorded.join(", ")}: unrecorded  project-owned skills with no lock entry`
  if (strict) {
    console.error(message)
    drift++
  } else {
    console.log(message)
  }
}

console.log(
  `${checked - drift} of ${locked.length} locked skills verified, ${unrecorded.length} unrecorded${
    strict ? " (strict)" : ""
  }`,
)
process.exit(drift > 0 ? 1 : 0)
