import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { buildChangelog, channelOf, isPrerelease } from "./build-changelog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "build-changelog.mjs");

describe("build-changelog helpers", () => {
  it("treats only the string 'true' as a prerelease", () => {
    assert.equal(isPrerelease("true"), true);
    assert.equal(isPrerelease("false"), false);
    assert.equal(isPrerelease(""), false);
    assert.equal(isPrerelease(undefined), false);
  });

  it("maps prerelease to the beta channel", () => {
    assert.equal(channelOf(true), "beta");
    assert.equal(channelOf(false), "stable");
  });

  it("builds a stable changelog entry", () => {
    assert.deepEqual(
      buildChangelog({
        version: "0.1.3",
        tag: "mausVoice-v0.1.3",
        name: "mausVoice v0.1.3",
        prerelease: false,
        notes: "Fixes.",
        date: "2026-09-09T00:00:00.000Z",
      }),
      {
        version: "0.1.3",
        tag: "mausVoice-v0.1.3",
        name: "mausVoice v0.1.3",
        prerelease: false,
        channel: "stable",
        date: "2026-09-09T00:00:00.000Z",
        notes: "Fixes.",
      },
    );
  });

  it("builds a beta changelog entry", () => {
    const entry = buildChangelog({
      version: "0.2.0-rc.1",
      tag: "mausVoice-v0.2.0-rc.1",
      name: "",
      prerelease: true,
      notes: "",
      date: "2026-09-09T00:00:00.000Z",
    });
    assert.equal(entry.channel, "beta");
    assert.equal(entry.name, "mausVoice mausVoice-v0.2.0-rc.1");
  });

  it("requires a version and a tag", () => {
    assert.throws(
      () =>
        buildChangelog({
          version: "",
          tag: "mausVoice-v0.1.3",
          name: "",
          prerelease: false,
          notes: "",
          date: "",
        }),
      /RELEASE_VERSION/,
    );
    assert.throws(
      () =>
        buildChangelog({
          version: "0.1.3",
          tag: "",
          name: "",
          prerelease: false,
          notes: "",
          date: "",
        }),
      /RELEASE_TAG/,
    );
  });
});

describe("build-changelog script", () => {
  let sandbox;
  let outPath;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "changelog-"));
    outPath = join(sandbox, "dist", "changelog.json");
    writeFileSync(join(sandbox, "body.md"), "# 0.1.3\n\nFixes.\n");
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes changelog.json from the release environment", () => {
    execFileSync(process.execPath, [script], {
      cwd: resolve(here, "..", ".."),
      env: {
        ...process.env,
        RELEASE_VERSION: "0.1.3",
        RELEASE_TAG: "mausVoice-v0.1.3",
        RELEASE_NAME: "mausVoice v0.1.3",
        RELEASE_PRERELEASE: "false",
        RELEASE_BODY_FILE: join(sandbox, "body.md"),
        CHANGELOG_OUT: outPath,
        SOURCE_DATE_EPOCH: "1788912000",
      },
      stdio: "pipe",
    });
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(written.version, "0.1.3");
    assert.equal(written.channel, "stable");
    assert.equal(written.date, "2026-09-09T00:00:00.000Z");
    assert.match(written.notes, /Fixes\./);
  });
});
