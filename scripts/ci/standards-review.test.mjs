import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkReceipt } from "./standards-review.mjs";

const script = fileURLToPath(
  new URL("./standards-review.mjs", import.meta.url),
);
const root = new URL("../../", import.meta.url);
const template = readFileSync(
  new URL(".github/pull_request_template.md", root),
  "utf8",
);
const standards = readFileSync(new URL("CODING_STANDARDS.md", root), "utf8");
const ids = [...standards.matchAll(/^## (CS\d+)\./gm)].map((m) => m[1]);
const expected = {
  branch: "stack/base",
  base: "a".repeat(40),
  head: "b".repeat(40),
  blob: "c".repeat(40),
  ids,
  paths: new Set(["nested/last.bin"]),
};
const evidence = {
  CS01: "the fixture opens no recording or device.",
  CS02: "the migration fixture preserves the stored row.",
  CS03: "the binary fixture contains no private content.",
  CS04: "the fixture makes no provider requests.",
  CS05: "the packet contains a Git binary patch.",
  CS06: "the fixture changes no user-facing control.",
  CS07: "the stale receipt fails after the base moves.",
  CS08: "the hook checks both commits in the range.",
};
const completeRows = (s) =>
  s.replace(
    /^- (CS\d+): <verified or not applicable>: <diff-specific evidence or reason>$/gm,
    (_, id) => `- ${id}: verified: \`nested/last.bin\` ${evidence[id]}`,
  );
const firstEvidence = `verified: \`nested/last.bin\` ${evidence.CS01}`;
const body = completeRows(
  template
    .replace(/0{40}/, expected.head)
    .replace("<base branch>", expected.branch)
    .replace(/0{40}/, expected.base)
    .replace(/0{40}/, expected.blob),
);

it("requires evidence for every section in the checked-in template", () => {
  checkReceipt(body, expected);
  for (const bad of [
    template,
    body.replace(expected.head, expected.base),
    body.replace(expected.blob, expected.head),
    body.replace(expected.branch, "main"),
    body.replace(/^- CS01:.*$/m, ""),
    body.replace("- CS02:", "- CS01:"),
    body.replace(firstEvidence, "verified: TODO"),
    body.replace(firstEvidence, "not applicable: <state why>"),
    `~~~md\n${body}\n~~~`,
    `<!--\n${body}\n-->`,
    `<!-- closed --> <!-- open\n${body}\n-->`,
    `~~~~md\n~~~\n${body}\n~~~~`,
    `MausAgent | Filed by fixture\n${body}`,
  ]) {
    assert.throws(() => checkReceipt(bad, expected));
  }
  checkReceipt(
    body.replace(
      firstEvidence,
      "not applicable: `nested/last.bin` does not open any resource.",
    ),
    expected,
  );
});

it("rejects boilerplate, unchanged paths and paths without an explanation", () => {
  for (const text of [
    "verified: reviewed carefully; no issues found",
    "verified: `unchanged/file.ts` was inspected for leaks",
    "not applicable: reviewed carefully; no issues found",
    "verified: `nested/last.bin`",
    "verified: `nested/last.bin` TODO: fill in this rule",
    "not applicable: `nested/last.bin` <state the actual reason>",
    `verified: \`nested/last.bin\` ${evidence.CS02}`,
  ]) {
    assert.throws(() =>
      checkReceipt(body.replace(firstEvidence, text), expected),
    );
  }
});

it("does not treat a changed filename as placeholder prose", () => {
  const path = "notes/TODO.md";
  checkReceipt(body.replaceAll("nested/last.bin", path), {
    ...expected,
    paths: new Set([path]),
  });
});

it("accepts only not-applicable dispositions for an empty diff", () => {
  const empty = { ...expected, paths: new Set() };
  const noChanges = body.replace(
    /verified: `nested\/last.bin` .+$/gm,
    "not applicable: base and head have identical trees.",
  );
  checkReceipt(noChanges, empty);
  assert.throws(() =>
    checkReceipt(noChanges.replace("not applicable:", "verified:"), empty),
  );
});

it("binds both gates to the full commit range, not the working directory or last commit", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "standards-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const eventFile = join(dir, "event.json");
  const run = (args, input = "", cwd = repo) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: eventFile },
    });
  const ok = (r) => assert.equal(r.status, 0, r.stderr);
  const red = (r) => assert.equal(r.status, 1, r.stdout);
  git("init", "-q", "-b", "topic");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(dir, "no-hooks"));
  const commit = (name) => {
    git("add", "-A");
    git("commit", "-qm", name);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(
    join(repo, "CODING_STANDARDS.md"),
    "## CS01. Ownership\n## CS02. Wire data\n",
  );
  const migrations = join(repo, "apps/desktop/src-tauri/src/db/migrations");
  mkdirSync(migrations, { recursive: true });
  const oldSql = join(migrations, "001_fixture.sql");
  writeFileSync(oldSql, "CREATE TABLE fixture(id INTEGER);\n");
  const base = commit("base");
  git("update-ref", "refs/heads/stack/base", base);
  git("remote", "add", "origin", repo);
  writeFileSync(join(repo, "first.txt"), "from the earlier commit\n");
  const intermediate = commit("first");
  writeFileSync(
    join(repo, "CODING_STANDARDS.md"),
    "## CS01. Ownership\n## CS03. Privacy\n",
  );
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "nested", "last.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(
    join(migrations, "002_add_name.sql"),
    "ALTER TABLE fixture ADD COLUMN name TEXT;\n",
  );
  const head = commit("last");
  const prepare = () =>
    run(["prepare", "stack/base"], "", join(repo, "nested"));
  const artifacts = join(repo, ".git", "standards-review");
  const draft = join(artifacts, "receipt.md");
  const update = (sha, target = "topic", previous = "0".repeat(40)) =>
    `refs/heads/topic ${sha} refs/heads/${target} ${previous}\n`;
  const push = (input = update(head)) => run(["pre-push", "origin"], input);
  const pr = (text, target = base, commit = head) => {
    writeFileSync(
      eventFile,
      JSON.stringify({
        pull_request: {
          body: text,
          base: { ref: "stack/base", sha: target },
          head: { sha: commit },
        },
      }),
    );
    return run(["check-pr"]);
  };
  red(push());
  ok(prepare());
  const patch = readFileSync(join(artifacts, "changes.patch"), "utf8");
  assert.match(patch, /from the earlier commit/);
  assert.match(patch, /GIT binary patch/);
  assert.equal(
    readFileSync(join(artifacts, "standards.md"), "utf8"),
    readFileSync(join(repo, "CODING_STANDARDS.md"), "utf8"),
  );
  const blank = readFileSync(draft, "utf8");
  red(pr(blank));
  red(push());
  const filled = completeRows(blank);
  assert.match(filled, /CS02:/); // Removed in the head, but its removal still requires review.
  ok(pr(filled));
  // The file exists on both sides, but the checked range did not change it.
  const unrelated = filled.replace(
    "`nested/last.bin`",
    "`apps/desktop/src-tauri/src/db/migrations/001_fixture.sql`",
  );
  red(pr(unrelated));
  writeFileSync(draft, unrelated);
  red(push());
  red(pr(filled.replace(/^- CS02:.*$/m, "")));
  red(pr(filled, intermediate));
  red(pr(filled, base, intermediate));
  writeFileSync(draft, filled);
  const dirty = join(repo, "unfinished.txt");
  writeFileSync(dirty, "in progress");
  red(prepare());
  assert.equal(readFileSync(draft, "utf8"), filled);
  rmSync(dirty);
  red(run(["prepare", "missing-base"]));
  assert.equal(readFileSync(draft, "utf8"), filled);
  assert.equal(readFileSync(join(artifacts, "changes.patch"), "utf8"), patch);
  red(push(update(head) + update(intermediate)));
  red(push(update(head, "stack/base")));
  red(push(update(head, "another-topic")));
  ok(push(""));
  const deletion = `(delete) ${"0".repeat(40)} refs/heads/old ${base}\n`;
  ok(push(deletion));
  red(push(update(head) + deletion));
  ok(push());
  red(push()); // One receipt per push attempt.
  ok(prepare());
  writeFileSync(draft, filled);
  // Both tips contain the base. The sibling even has the same tree as HEAD,
  // but publishing HEAD would lose the other contributor's commit.
  const sibling = git(
    "commit-tree",
    `${head}^{tree}`,
    "-p",
    intermediate,
    "-m",
    "other work",
  );
  for (const previous of [sibling, "d".repeat(40)]) {
    const rejected = push(update(head, "topic", previous));
    red(rejected);
    assert.match(rejected.stderr, /fast-forward/);
  }
  assert.equal(readFileSync(draft, "utf8"), filled);
  ok(push(update(head, "topic", intermediate)));
  ok(prepare());
  writeFileSync(draft, filled);
  git("update-ref", "refs/heads/stack/base", intermediate);
  red(push());
  // Even a fresh and complete attestation cannot override an executable standard.
  for (const mutate of [
    () => writeFileSync(oldSql, "SELECT 1;"),
    () => rmSync(oldSql),
  ]) {
    mutate();
    const invalid = commit("rewrite history");
    ok(prepare());
    const fresh = completeRows(readFileSync(draft, "utf8"));
    writeFileSync(draft, fresh);
    for (const r of [pr(fresh, intermediate, invalid), push(update(invalid))]) {
      red(r);
      assert.match(r.stderr, /CS02: append a new migration/);
    }
  }
  writeFileSync(join(repo, "first.txt"), "uncommitted\n");
  red(prepare());
});

it("selects the immutable checker and fails closed on an incomplete base", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "standards-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts/ci"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.hooksPath", join(dir, "no-hooks"));
  git("config", "commit.gpgsign", "false");
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const empty = commit();
  writeFileSync(join(repo, "CODING_STANDARDS.md"), "## CS01. Ownership\n");
  const policyOnly = commit();
  const checker = join(repo, "scripts/ci/standards-review.mjs");
  writeFileSync(checker, 'console.log("base checker");');
  const installed = commit();
  writeFileSync(checker, 'console.log("proposed checker");');
  const workflow = readFileSync(
    new URL(".github/workflows/pr-body.yml", root),
    "utf8",
  );
  const step = workflow
    .split("- name: Verify the receipt against the event commits")[1]
    .split("      - name:")[0];
  const run = (base) =>
    spawnSync("bash", ["-c", step.split("run: |\n")[1]], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: dir, BASE_SHA: base },
    });
  const first = run(empty);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /proposed checker/);
  const complete = run(installed);
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /^base checker$/m);
  const partial = run(policyOnly);
  assert.equal(partial.status, 1);
  assert.match(
    partial.stdout,
    /has CODING_STANDARDS.md but no scripts\/ci\/standards-review.mjs/,
  );
  assert.doesNotMatch(partial.stdout, /proposed checker/);
  assert.notEqual(run("missing-base").status, 0);
});
