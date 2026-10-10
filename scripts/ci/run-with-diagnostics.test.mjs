import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = join(root, "scripts/ci/run-with-diagnostics.sh");
const temporary = mkdtempSync(join(tmpdir(), "maus-ci-diagnostics "));
after(() => rmSync(temporary, { recursive: true, force: true }));

function runBlock(workflow, stepName) {
  const lines = readFileSync(join(root, workflow), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(step, -1, stepName);
  const run = lines.findIndex(
    (line, index) => index > step && /^        run:/.test(line),
  );
  const inline = lines[run].replace(/^        run:\s*/, "");
  if (inline !== "|") return inline;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function execute(block, status, { silent = false, teeStatus } = {}) {
  const cwd = mkdtempSync(join(temporary, "workspace "));
  mkdirSync(join(cwd, "scripts/ci"), { recursive: true });
  mkdirSync(join(cwd, "bin"));
  const fixture = `#!/usr/bin/env bash
${silent ? "" : 'printf "fixture output: 100%%\\rnext\\n"'}
exit "${status}"
`;
  writeFileSync(join(cwd, "bin/cargo"), fixture, { mode: 0o755 });
  writeFileSync(join(cwd, "scripts/check-bindings.sh"), fixture, {
    mode: 0o755,
  });
  if (teeStatus !== undefined) {
    writeFileSync(
      join(cwd, "bin/tee"),
      `#!/usr/bin/env bash
cat >/dev/null
exit ${teeStatus}
`,
      { mode: 0o755 },
    );
  }
  if (existsSync(helper))
    copyFileSync(helper, join(cwd, "scripts/ci/run-with-diagnostics.sh"));
  return spawnSync("bash", ["-eo", "pipefail", "-c", block], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
      GITHUB_WORKSPACE: cwd,
      RUNNER_TEMP: cwd,
      FIXTURE_STATUS: String(status),
    },
  });
}

const steps = [
  [
    ".github/workflows/test-package-rust-transcription.yml",
    "Run transcription unit tests",
  ],
  [".github/workflows/lint-desktop.yml", "Lint Rust"],
  [".github/workflows/test-desktop-unit.yml", "Run Rust unit tests"],
  [
    ".github/workflows/test-package-rust-transcription.yml",
    "Run non-ignored integration tests",
  ],
  [
    ".github/workflows/test-desktop-unit.yml",
    "Verify generated bindings are in sync",
  ],
];

describe("CI diagnostic command blocks", () => {
  for (const [workflow, step] of steps) {
    it(`${step} emits no error annotation after success`, () => {
      const result = execute(runBlock(workflow, step), 0);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /fixture output/);
      assert.doesNotMatch(result.stdout, /::error::/);
    });
    it(`${step} preserves failures and escapes its annotation`, () => {
      const result = execute(runBlock(workflow, step), 17);
      assert.equal(result.status, 17, result.stderr);
      assert.match(result.stdout, /::error::/);
      assert.match(result.stdout, /100%25%0Dnext/);
    });
  }
});

describe("diagnostic helper edge cases", () => {
  const command =
    'bash "$GITHUB_WORKSPACE/scripts/ci/run-with-diagnostics.sh" fixture cargo';
  it("accepts silent success without fabricating an empty-log error", () => {
    const result = execute(command, 0, { silent: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });
  it("reports a silent failure", () => {
    const result = execute(command, 23, { silent: true });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stdout, /No diagnostic output was captured/);
  });
  it("fails when logging fails after command success", () => {
    const result = execute(command, 0, { teeStatus: 9 });
    assert.equal(result.status, 9, result.stderr);
  });
  it("keeps the command failure when logging also fails", () => {
    const result = execute(command, 17, { teeStatus: 9 });
    assert.equal(result.status, 17, result.stderr);
  });
});
