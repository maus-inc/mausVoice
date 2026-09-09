#!/usr/bin/env node

// Builds the per-release changelog artifact (`changelog.json`) from the same
// normalized release-note input as the GitHub release body and the updater
// manifest notes, so all three always agree.
//
// Reads:
//   RELEASE_VERSION    - e.g. 0.1.3
//   RELEASE_TAG        - e.g. mausVoice-v0.1.3
//   RELEASE_NAME       - e.g. mausVoice v0.1.3
//   RELEASE_PRERELEASE - "true" | "false"
//   RELEASE_BODY_FILE  - markdown file produced by generate-release-body.mjs
//   CHANGELOG_OUT      - where to write changelog.json (default dist/changelog.json)
//   SOURCE_DATE_EPOCH  - optional fixed timestamp (reproducible builds/tests)

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function isPrerelease(value) {
  // "false" is a truthy string in Node, so compare explicitly.
  return value === "true";
}

export function channelOf(prerelease) {
  return prerelease ? "beta" : "stable";
}

export function buildChangelog({
  version,
  tag,
  name,
  prerelease,
  notes,
  date,
}) {
  if (!version) {
    throw new Error("RELEASE_VERSION is required");
  }
  if (!tag) {
    throw new Error("RELEASE_TAG is required");
  }
  return {
    version,
    tag,
    name: name || `mausVoice ${tag}`,
    prerelease: Boolean(prerelease),
    channel: channelOf(prerelease),
    date,
    notes: notes ?? "",
  };
}

async function main() {
  const version = process.env.RELEASE_VERSION ?? "";
  const tag = process.env.RELEASE_TAG ?? "";
  const name = process.env.RELEASE_NAME ?? "";
  const prerelease = isPrerelease(process.env.RELEASE_PRERELEASE);
  const bodyFile = process.env.RELEASE_BODY_FILE ?? "";
  const outPath = process.env.CHANGELOG_OUT ?? "dist/changelog.json";

  let notes = "";
  if (bodyFile) {
    notes = await fs.readFile(bodyFile, "utf8").catch(() => "");
  }

  const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? "");
  const date = Number.isFinite(epoch) && epoch > 0
    ? new Date(epoch * 1000).toISOString()
    : new Date().toISOString();

  const changelog = buildChangelog({ version, tag, name, prerelease, notes, date });
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(changelog, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

export function isDirectInvocation(
  moduleUrl,
  scriptPath,
  windows = process.platform === "win32",
) {
  return (
    Boolean(scriptPath) &&
    moduleUrl === pathToFileURL(scriptPath, { windows }).href
  );
}

// Only run when executed directly, so the tests can import the helpers.
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
