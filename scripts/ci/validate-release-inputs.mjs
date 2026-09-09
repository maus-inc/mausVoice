#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Strict SemVer 2.0.0 validation for the release dispatcher. Keeping this
 * separate from the workflow makes the grammar executable and regression
 * testable instead of approximating it with a shell glob.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const isStrictSemver = (version) => SEMVER.test(version);

export const isPrereleaseVersion = (version) => {
  const match = SEMVER.exec(version);
  return match?.[4] !== undefined;
};

/**
 * Return the release channel encoded by a strict SemVer version. Keeping this
 * beside the grammar gives workflow callers the same answer as dispatcher
 * validation; notably, a hyphen in build metadata does not make a prerelease.
 */
export const releaseVersionIsPrerelease = (version) => {
  if (!isStrictSemver(version)) {
    throw new Error(
      `Invalid version '${version}' (expected SemVer 2.0.0, e.g. 0.1.3 or 0.2.0-rc.1)`,
    );
  }
  return isPrereleaseVersion(version);
};

export const validateReleaseInputs = ({ version, prerelease }) => {
  const versionIsPrerelease = releaseVersionIsPrerelease(version);
  if (prerelease !== "true" && prerelease !== "false") {
    throw new Error(
      `Invalid prerelease flag '${prerelease}' (expected literal true or false)`,
    );
  }

  if (versionIsPrerelease !== (prerelease === "true")) {
    throw new Error(
      `Version '${version}' is a ${versionIsPrerelease ? "prerelease" : "stable"} version, but the prerelease input is ${prerelease}. Set the prerelease checkbox to match the version, or the release will land in the wrong update channel.`,
    );
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const version = process.env.RELEASE_VERSION ?? "";
    const prerelease = process.env.INPUT_PRERELEASE ?? "";
    validateReleaseInputs({ version, prerelease });

    if (process.argv[2] === "--print-prerelease") {
      // Workflow shell must consume this rather than guessing from a hyphen:
      // SemVer build metadata can legally contain hyphens while remaining
      // stable (for example, `1.2.3+build-foo`).
      process.stdout.write(
        releaseVersionIsPrerelease(version) ? "true" : "false",
      );
    } else if (process.argv[2] !== undefined) {
      throw new Error(`Unknown argument '${process.argv[2]}'`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
