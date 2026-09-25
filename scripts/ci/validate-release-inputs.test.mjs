import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPrereleaseVersion,
  isStrictSemver,
  releaseVersionIsPrerelease,
  validateReleaseInputs,
} from "./validate-release-inputs.mjs";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "validate-release-inputs.mjs",
);

describe("release dispatcher inputs", () => {
  it("accepts stable and prerelease SemVer 2.0.0 inputs on their matching channels", () => {
    assert.equal(isStrictSemver("0.1.3"), true);
    assert.equal(isStrictSemver("12.34.56-rc.1+build.7"), true);
    assert.equal(isStrictSemver("12.34.56-01a"), true);
    assert.equal(isPrereleaseVersion("0.1.3"), false);
    assert.equal(isPrereleaseVersion("12.34.56-rc.1+build.7"), true);
    assert.doesNotThrow(() =>
      validateReleaseInputs({ version: "0.1.3", prerelease: "false" }),
    );
    assert.doesNotThrow(() =>
      validateReleaseInputs({
        version: "12.34.56-rc.1+build.7",
        prerelease: "true",
      }),
    );
  });

  it("keeps hyphenated build metadata on the stable channel in the workflow command", () => {
    const version = "1.2.3+build-foo";
    assert.equal(isStrictSemver(version), true);
    assert.equal(isPrereleaseVersion(version), false);
    assert.equal(releaseVersionIsPrerelease(version), false);
    assert.doesNotThrow(() =>
      validateReleaseInputs({ version, prerelease: "false" }),
    );
    assert.throws(
      () => validateReleaseInputs({ version, prerelease: "true" }),
      /stable version, but the prerelease input is true/,
    );

    // This is the exact CLI the release workflow calls to classify a version.
    // It protects against returning to a shell `*-*` heuristic by exercising
    // the machine-readable output consumed by that shell step.
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--print-prerelease"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_VERSION: version,
          INPUT_PRERELEASE: "false",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "false");
    assert.equal(result.stderr, "");
  });

  it("rejects values the previous glob classified as valid version numbers", () => {
    for (const version of [
      "a",
      "1",
      "1.2",
      "01.2.3",
      "1.2.3-",
      "1.2.3-01",
      "1.2.3-rc_1",
    ]) {
      assert.equal(isStrictSemver(version), false, version);
      assert.throws(
        () => validateReleaseInputs({ version, prerelease: "false" }),
        /Invalid version/,
        version,
      );
    }
  });

  it("rejects prerelease-channel mismatches and malformed boolean flags", () => {
    assert.throws(
      () =>
        validateReleaseInputs({ version: "0.2.0-rc.1", prerelease: "false" }),
      /prerelease input is false/,
    );
    assert.throws(
      () => validateReleaseInputs({ version: "0.2.0", prerelease: "true" }),
      /prerelease input is true/,
    );
    assert.throws(
      () => validateReleaseInputs({ version: "0.2.0", prerelease: "yes" }),
      /literal true or false/,
    );
  });
});
