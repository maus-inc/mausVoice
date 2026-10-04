import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const run = (file, cwd, env) =>
  execFileSync(process.execPath, [join(scripts, file)], {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });

describe("one release-notes source", () => {
  for (const [name, notes, beta] of [
    [
      "stable custom notes",
      "  ### Changes\r\n\r\n- Keep **formatting**.\r\n",
      false,
    ],
    ["beta custom notes", "- Beta changes", true],
    ["generated fallback notes", "", false],
  ]) {
    it(`shares ${name} across the release body, changelog and updater`, (t) => {
      const cwd = mkdtempSync(join(tmpdir(), "release-notes-"));
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      writeFileSync(join(cwd, "app.msi"), "fixture bundle");
      writeFileSync(join(cwd, "app.msi.sig"), "fixture signature");
      const notesFile = join(cwd, "notes.md");
      const manifestFile = join(cwd, beta ? "latest-beta.json" : "latest.json");
      const changelogFile = join(cwd, "changelog.json");
      const env = {
        ...process.env,
        ARTIFACTS_DIR: cwd,
        RELEASE_VERSION: beta ? "0.1.6-beta.1" : "0.1.6",
        RELEASE_TAG: beta ? "mausVoice-v0.1.6-beta.1" : "mausVoice-v0.1.6",
        RELEASE_NAME: "Fixture release",
        RELEASE_PRERELEASE: String(beta),
        RELEASE_NOTES: notes,
        RELEASE_NOTES_FILE: notesFile,
        RELEASE_BODY_FILE: join(cwd, "body.md"),
        OUTPUT_PATH: manifestFile,
        CHANGELOG_OUT: changelogFile,
        GITHUB_REPOSITORY: "maus-inc/mausVoice",
      };
      const body = run("generate-release-body.mjs", cwd, env);
      writeFileSync(env.RELEASE_BODY_FILE, body);
      run("build-changelog.mjs", cwd, env);
      run("build-updater-manifest.mjs", cwd, env);
      const changelog = JSON.parse(readFileSync(changelogFile, "utf8"));
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      assert.equal(changelog.notes, manifest.notes);
      const normalized = readFileSync(notesFile, "utf8");
      assert.equal(changelog.notes, normalized);
      assert.ok(normalized.length > 0);
      assert.ok(body.includes(normalized));
      assert.ok(!normalized.includes("## Downloads"));
      if (notes) assert.equal(normalized, notes.replace(/\r\n?/g, "\n").trim());
    });
  }
  it("fails closed if an explicitly selected notes artifact is missing", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "release-notes-missing-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    assert.throws(
      () =>
        run("build-changelog.mjs", cwd, {
          ...process.env,
          RELEASE_VERSION: "0.1.6",
          RELEASE_TAG: "mausVoice-v0.1.6",
          RELEASE_NOTES_FILE: join(cwd, "missing.md"),
          RELEASE_BODY_FILE: "",
          CHANGELOG_OUT: join(cwd, "out.json"),
        }),
      /ENOENT/,
    );
  });
  it("wires both manifest channels and the changelog to the one generated notes file", () => {
    const workflow = readFileSync(
      resolve(scripts, "../../.github/workflows/release.yml"),
      "utf8",
    );
    assert.equal(
      workflow.split("RELEASE_NOTES_FILE: ${{ steps.body.outputs.notes_file }}")
        .length - 1,
      2,
    );
    assert.ok(
      workflow.includes(
        'echo "notes_file=$RELEASE_NOTES_FILE" >> "$GITHUB_OUTPUT"',
      ),
    );
  });
});
