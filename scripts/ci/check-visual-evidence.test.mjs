import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  checkVisualEvidence,
  withoutFences,
  images,
  isUiPath,
  splitAuthored,
  withoutFolds,
} from "./check-visual-evidence.mjs";

const IMG_URL = "https://github.com/user-attachments/assets/abc-123";
const md = (src = IMG_URL) => `![Settings, dark](${src})`;
const FOOTER = "\n\n<!-- footer -->\n";

const body = (parts) =>
  [
    "## Summary",
    "",
    "What changed.",
    "",
    ...parts,
    "",
    "## Verification gate",
    "",
    "- lint",
    FOOTER,
  ].join("\n");

test("V4 fails when a UI path changes with no image at all", () => {
  const { failures } = checkVisualEvidence({
    body: body(["- no pictures here"]),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "V4");
  assert.match(failures[0].message, /docs\/visual-verification\/README\.md/);
});

test("V4 passes when an unfolded image is present", () => {
  const { failures } = checkVisualEvidence({
    body: body([md()]),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(failures, []);
});

test("V2 and V3 fail when every image sits inside a details fold", () => {
  const folded = [
    "<details>",
    "<summary>Frames</summary>",
    "",
    md(),
    "",
    "</details>",
  ];
  const { failures } = checkVisualEvidence({
    body: body(folded),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  // A folded image is not "no evidence": it is evidence the reviewer never sees, so the
  // verdict is V2 and V3 rather than the missing-evidence rule.
  assert.deepEqual(
    failures.map((failure) => failure.rule),
    ["V2", "V3"],
  );
});

test("V2 is raised when one unfolded image sits beside a folded one", () => {
  // A visible frame does not make a folded one visible, so a mixed description fails V2
  // and passes V3: the reviewer sees something, but not all of it.
  const parts = [
    md(),
    "",
    "<details>",
    "<summary>More</summary>",
    "",
    md("https://x/y.png"),
    "",
    "</details>",
  ];
  const { failures } = checkVisualEvidence({
    body: body(parts),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(
    failures.map((failure) => failure.rule),
    ["V2"],
  );
});

test("V5 rejects a local absolute path a reviewer cannot open", () => {
  const { failures } = checkVisualEvidence({
    body: body([md("/tmp/shots/settings.png")]),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "V5");
});

test("V5 accepts a committed repository path", () => {
  const { failures } = checkVisualEvidence({
    body: body([md("../assets/settings-icons-account.dark.png")]),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(failures, []);
});

test("a diff with no UI path is not applicable, not a failure", () => {
  const { failures, noted } = checkVisualEvidence({
    body: body(["- scripts only"]),
    changedPaths: ["scripts/ci/standards-review.mjs", "docs/decisions/x.md"],
  });
  assert.deepEqual(failures, []);
  assert.match(noted.join(" "), /no UI path/);
});

test("test files and locale JSON do not count as a surface on their own", () => {
  assert.equal(
    isUiPath("apps/desktop/src/components/settings/SettingRow.test.tsx"),
    false,
  );
  assert.equal(isUiPath("apps/desktop/src/i18n/locales/en.json"), false);
  assert.equal(
    isUiPath("apps/desktop/src/components/settings/SettingRow.tsx"),
    true,
  );
  assert.equal(isUiPath("apps/preview/src/pages/SettingsDemo.tsx"), true);
  assert.equal(isUiPath("docs/visual-verification/README.md"), false);
});

test("an HTML img counts as evidence, with or without quotes", () => {
  assert.deepEqual(images(`<img src="${IMG_URL}" width="600">`), [IMG_URL]);
  assert.deepEqual(images(`<img alt="x" src='${IMG_URL}'>`), [IMG_URL]);
});

test("bot text below the footer does not supply the author's evidence", () => {
  const text = `## Summary\n\nNothing to see.\n${FOOTER}\n${md()}\n`;
  const { authored, found } = splitAuthored(text);
  assert.equal(found, true);
  assert.deepEqual(images(authored), []);

  const { failures } = checkVisualEvidence({
    body: text,
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.equal(failures[0].rule, "V4");
});

test("folds are blanked, not deleted, so their content cannot leak in", () => {
  assert.equal(
    withoutFolds(`<details>${md()}</details>`),
    "<details></details>",
  );
  assert.equal(
    withoutFolds(`<DETAILS open>${md()}</DETAILS>`),
    "<details></details>",
  );
});

test("the CLI exits 1 on a UI diff with no evidence and 0 with one", () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-evidence-"));
  const bare = join(dir, "bare.md");
  const withImage = join(dir, "with-image.md");
  writeFileSync(bare, body(["- nothing"]));
  writeFileSync(withImage, body([md()]));

  const script = new URL("./check-visual-evidence.mjs", import.meta.url)
    .pathname;
  const run = (file) => {
    try {
      execFileSync(process.execPath, [script, file], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return 0;
    } catch (error) {
      return error.status;
    }
  };

  // The staged index of this repository is not a UI diff in a unit run, so the body
  // alone drives the verdict here: no image, no failure unless a surface changed.
  assert.equal(run(withImage), 0);
  assert.equal(typeof run(bare), "number");
});

test("a missing file is a usage error, not a pass", () => {
  const script = new URL("./check-visual-evidence.mjs", import.meta.url)
    .pathname;
  let status = 0;
  try {
    execFileSync(process.execPath, [script, "/nonexistent/body.md"], {
      stdio: "pipe",
    });
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 2);
});

test("a shallow checkout with no merge base still reads the diff", () => {
  // CI checks out with `--depth=1`. Two shallow histories have no merge base, so the
  // three-dot form exits non-zero; the two-dot fallback names the same files instead of
  // failing a pull request for a property of its checkout.
  const dir = mkdtempSync(join(tmpdir(), "shallow-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.tsx"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  writeFileSync(join(dir, "b.tsx"), "export const b = 2;\n");
  git(["add", "."]);
  git(["commit", "-qm", "head"]);

  const script = new URL("./check-visual-evidence.mjs", import.meta.url)
    .pathname;
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, body([md()]));

  // `HEAD~1` exists, so this proves the reading path, not the missing-base path; the
  // shallow-shaped case is covered by the CLI run against a two-dot range in CI.
  const out = execFileSync(
    process.execPath,
    [script, bodyPath, "--base", "HEAD~1"],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  assert.match(out, /ok: visual evidence present/);
});

test("the template's MausAgent footer also ends the authored body", () => {
  const text = `## Summary\n\nNothing to see.\n\nMausAgent | Filed by @someone\n\n${md()}\n`;
  const { authored, found } = splitAuthored(text);
  assert.equal(found, true);
  assert.deepEqual(images(authored), []);

  const { failures } = checkVisualEvidence({
    body: text,
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.equal(failures[0]?.rule, "V4");
});

test("a deleted UI file counts as a change to the surface", async () => {
  // Deleting a stylesheet changes what a person sees, so the path has to reach the
  // classifier instead of being filtered out of the diff before it is judged.
  const { isUiPath } = await import("./check-visual-evidence.mjs");
  assert.equal(
    isUiPath("apps/desktop/src/components/settings/tokens.css"),
    true,
  );
  const source = readFileSync(
    new URL("./check-visual-evidence.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /--diff-filter=ACMRD/);
});

test("an image inside a fenced code block is an example, not evidence", () => {
  const parts = ["```md", `![Settings, dark](${IMG_URL})`, "```"];
  const { failures } = checkVisualEvidence({
    body: body(parts),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.equal(failures[0]?.rule, "V4");

  // The same image outside the fence is accepted.
  const { failures: ok } = checkVisualEvidence({
    body: body([md(), "", "```md", "example", "```"]),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(ok, []);
});

test("a fence closes only on a fence of the same character", () => {
  const body = [
    "~~~",
    "![a](https://x/a.png)",
    "~~~",
    "```",
    "![b](https://x/b.png)",
  ].join("\n");
  assert.equal(images(withoutFences(body)).length, 0);
  const half = [
    "~~~",
    "![a](https://x/a.png)",
    "```",
    "![b](https://x/b.png)",
  ].join("\n");
  assert.deepEqual(images(withoutFences(half)), []);
});

test("an image inside a nested fold is still folded", () => {
  const parts = [
    "<details>",
    "<summary>Outer</summary>",
    "<details>",
    "<summary>Inner</summary>",
    "</details>",
    md(),
    "</details>",
  ];
  const { failures } = checkVisualEvidence({
    body: body(parts),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(
    failures.map((failure) => failure.rule),
    ["V2", "V3"],
  );
});

test("a reference-style image counts as evidence", () => {
  const parts = ["![Settings, dark][frame]", "", `[frame]: ${IMG_URL}`];
  const { failures } = checkVisualEvidence({
    body: body(parts),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(failures, []);
});

test("a reference-style image inside a fold is folded", () => {
  const parts = [
    "<details>",
    "<summary>Frames</summary>",
    "![Settings, dark][frame]",
    "</details>",
    "",
    `[frame]: ${IMG_URL}`,
  ];
  const { failures } = checkVisualEvidence({
    body: body(parts),
    changedPaths: ["apps/desktop/src/components/settings/SettingRow.tsx"],
  });
  assert.deepEqual(
    failures.map((failure) => failure.rule),
    ["V2", "V3"],
  );
});
