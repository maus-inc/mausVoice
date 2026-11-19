// No package install in CI. Once the policy lands, the PR job runs this file from the base commit.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const document = "CODING_STANDARDS.md";
const title = "<summary>Full-diff coding standards review</summary>";
const attestation =
  "I applied the entire CODING_STANDARDS.md to the entire base-to-head diff.";
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trimEnd();
const fail = (message) => {
  throw new Error(message);
};
const validSha = (sha) => /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha);

function rules(text) {
  const ids = [...text.matchAll(/^## (CS\d+)\. \S.+$/gm)].map((m) => m[1]);
  if (!ids.length || new Set(ids).size !== ids.length)
    fail("Standards need unique numbered CS sections.");
  return ids;
}

function subject(branch, base, head) {
  git("check-ref-format", `refs/heads/${branch}`);
  if (!validSha(base) || !validSha(head))
    fail("Expected full base and head commit SHAs.");
  git("merge-base", "--is-ancestor", base, head);
  const blob = git("rev-parse", `${head}:${document}`);
  const text = git("cat-file", "blob", blob);
  const prior = git("ls-tree", "--name-only", base, "--", document)
    ? git("show", `${base}:${document}`)
    : null;
  return {
    branch,
    base,
    head,
    blob,
    ids: [
      ...new Set([...rules(text), ...(prior === null ? [] : rules(prior))]),
    ],
  };
}

function header({ branch, base, head, blob }) {
  return [
    "## Verification gate",
    "",
    `Head SHA: \`${head}\``,
    "",
    `Base: \`${branch}\` at \`${base}\`, contained in the head above.`,
    "",
    "<details>",
    title,
    "",
    `Standards blob: \`${blob}\``,
    "",
    attestation,
  ];
}

function skeleton(item) {
  return [
    ...header(item),
    "",
    ...item.ids.map(
      (id) =>
        `- ${id}: <verified or not applicable>: <diff-specific evidence or reason>`,
    ),
    "",
    "</details>",
    "",
  ].join("\n");
}

function hiddenLine(line, state) {
  if (state.fence) {
    const close = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
    if (close?.startsWith(state.fence)) state.fence = null;
    return true;
  }
  if (state.comment || line.includes("<!--")) {
    // A line may close one comment and open another. Treat such lines as
    // noise rather than accepting part of an attestation hidden on them.
    for (const token of line.match(/<!--|-->/g) ?? []) {
      state.comment = token === "<!--";
    }
    return true;
  }
  state.fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  return Boolean(state.fence);
}

// Ignore examples, hidden comments and bot material below the footer.
function authoredLines(body) {
  const lines = [];
  const state = { fence: null, comment: false };
  for (const raw of body.split(/\r?\n/)) {
    if (hiddenLine(raw, state)) continue;
    if (/^MausAgent \| Filed by /.test(raw)) break;
    if (raw.trim()) lines.push(raw.trimEnd());
  }
  return lines;
}

export function checkReceipt(body, item) {
  const lines = authoredLines(body);
  const expected = header(item).filter(Boolean);
  const start = lines.indexOf(expected[0]);
  if (
    start === -1 ||
    lines.lastIndexOf(expected[0]) !== start ||
    lines.filter((s) => s === title).length !== 1 ||
    !expected.every((s, i) => lines[start + i] === s)
  ) {
    fail(
      "Missing or stale standards review. Use the receipt for the actual base, head and standards blob in the verification gate.",
    );
  }
  const from = start + expected.length;
  const end = lines.indexOf("</details>", from);
  if (end < 0) fail("Unclosed standards review.");
  const missing = new Set(item.ids);
  for (const line of lines.slice(from, end)) {
    const row = /^- (CS\d+): (verified|not applicable): (\S.*)$/u.exec(line);
    if (!row || !missing.delete(row[1]))
      fail(`Missing, unknown or duplicate disposition: ${line.slice(0, 60)}`);
    const evidence = row[3].trim();
    if (
      evidence.length < 12 ||
      /[<>]|\b(?:TODO|TBD|placeholder)\b|^diff-specific evidence/i.test(
        evidence,
      )
    )
      fail(`Give diff-specific evidence or a reason for ${row[1]}.`);
  }
  if (missing.size) fail(`Missing review of ${[...missing].join(", ")}.`);
}

// An existing base migration may already have run on a user's database. An
// additional migration is reviewable; rewriting or removing its predecessor is not.
function verify(body, item) {
  checkReceipt(body, item);
  const changed = git(
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    "--diff-filter=MDT",
    item.base,
    item.head,
    "--",
    ":(top,glob)apps/desktop/src-tauri/src/db/migrations/*.sql",
  );
  if (changed)
    fail(
      `CS02: append a new migration instead of changing ${changed.split("\0").filter(Boolean).join(", ")}.`,
    );
}

function cleanHead() {
  if (git("status", "--porcelain"))
    fail("Commit the final tree before reviewing or pushing it.");
  return git("rev-parse", "HEAD");
}

const reviewDir = () =>
  resolve(git("rev-parse", "--git-path", "standards-review"));
function saveGit(path, args) {
  const fd = openSync(path, "w", 0o600);
  try {
    execFileSync("git", args, { stdio: ["ignore", fd, "inherit"] });
  } finally {
    closeSync(fd);
  }
}

function prepare(branch) {
  if (!branch)
    fail(
      "Usage: node scripts/ci/standards-review.mjs prepare <PR-base-branch>",
    );
  git("check-ref-format", `refs/heads/${branch}`);
  const head = cleanHead();
  git("fetch", "--no-tags", "origin", `refs/heads/${branch}`);
  const item = subject(branch, git("rev-parse", "FETCH_HEAD"), head);
  const dir = reviewDir();
  mkdirSync(dir, { recursive: true });
  const packet = mkdtempSync(join(dir, "prepare-"));
  try {
    saveGit(join(packet, "standards.md"), ["cat-file", "blob", item.blob]);
    saveGit(join(packet, "changes.patch"), [
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-textconv",
      "--no-ext-diff",
      "--no-renames",
      "--ignore-submodules=none",
      `${item.base}...${head}`,
      "--",
    ]);
    writeFileSync(join(packet, "base-branch"), branch, { mode: 0o600 });
    writeFileSync(join(packet, "receipt.md"), skeleton(item), { mode: 0o600 });
    // Publish only after Git produced the complete packet. Replace the receipt
    // last so a failed preparation does not destroy a reviewer's notes.
    for (const file of [
      "standards.md",
      "changes.patch",
      "base-branch",
      "receipt.md",
    ]) {
      renameSync(join(packet, file), join(dir, file));
    }
  } finally {
    rmSync(packet, { recursive: true, force: true });
  }
  console.log(
    `Read ${dir}/standards.md and changes.patch in full. Fill each row in receipt.md only after review.`,
  );
}

function prePush(remote, updates) {
  // Git also invokes the hook for a no-op and for deleting a merged branch; neither submits a diff.
  const changes = updates
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(" ");
      if (fields.length !== 4) fail("Invalid pre-push ref update.");
      return { sha: fields[1], destination: fields[2] };
    });
  if (changes.every(({ sha }) => /^0{40}$/.test(sha))) return;
  const dir = reviewDir();
  const draft = join(dir, "receipt.md");
  const branch = readFileSync(join(dir, "base-branch"), "utf8");
  const head = cleanHead();
  const destination = git("symbolic-ref", "HEAD");
  if (
    remote !== "origin" ||
    destination === `refs/heads/${branch}` ||
    changes.length !== 1 ||
    changes[0].sha !== head ||
    changes[0].destination !== destination
  )
    fail(
      "Push only the reviewed head to its own branch on origin, not to the PR base or another ref.",
    );
  git("check-ref-format", `refs/heads/${branch}`);
  const [base] = git(
    "ls-remote",
    "--exit-code",
    "--refs",
    "origin",
    `refs/heads/${branch}`,
  ).split("\t");
  verify(readFileSync(draft, "utf8"), subject(branch, base, head));
  renameSync(draft, join(dir, "last-review.md"));
  console.log(
    `Review accepted for ${head}. Paste ${dir}/last-review.md into the PR description.`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.chdir(git("rev-parse", "--show-toplevel"));
    const [command, arg] = process.argv.slice(2);
    if (command === "prepare") prepare(arg);
    else if (command === "pre-push") prePush(arg, readFileSync(0, "utf8"));
    else if (command === "check-pr") {
      const { pull_request: pr } = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
      );
      verify(pr.body ?? "", subject(pr.base.ref, pr.base.sha, pr.head.sha));
      console.log(`Full-diff standards review present for ${pr.head.sha}.`);
    } else
      fail(
        "Expected prepare <PR-base-branch>, pre-push <remote>, or check-pr.",
      );
  } catch (error) {
    console.error(`Standards review failed: ${error.message}`);
    process.exitCode = 1;
  }
}
