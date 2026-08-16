#!/usr/bin/env node

// Builds the Tauri v2 updater manifest (`latest.json`) from the installers a
// release run produced.
//
// Reads:
//   ARTIFACTS_DIR      - downloaded artifact root (dist/)
//   RELEASE_VERSION    - e.g. 0.1.3
//   RELEASE_TAG        - e.g. mausVoice-v0.1.3
//   RELEASE_NOTES      - optional markdown for the manifest "notes" field
//   RELEASE_PRERELEASE - "true" | "false"
//   OUTPUT_PATH        - where to write latest.json
//
// A manifest entry is only emitted for a bundle that has a matching `.sig`
// next to it. An entry without a signature is worse than a missing entry:
// the client would download the artifact and then fail signature
// verification, which surfaces to the user as a broken install rather than
// "you are up to date".

import { promises as fs } from "node:fs";
import path from "node:path";

// Tauri asks for a manifest key per target triple. macOS ships a single
// universal bundle, so both architectures resolve to the same artifact.
const PLATFORM_TARGETS = [
  {
    key: "darwin-aarch64",
    matches: (name) => name.endsWith(".app.tar.gz"),
  },
  {
    key: "darwin-x86_64",
    matches: (name) => name.endsWith(".app.tar.gz"),
  },
  {
    key: "windows-x86_64",
    matches: (name) => name.endsWith(".nsis.zip"),
  },
  {
    key: "linux-x86_64",
    matches: (name) => name.toLowerCase().endsWith(".appimage"),
  },
];

export function isPrerelease(value) {
  // "false" is a truthy string in Node, so compare explicitly.
  return value === "true";
}

export function assetUrl(repository, tag, basename) {
  // GitHub flattens release assets to their basenames, so the download URL
  // never carries the nested artifact-directory path.
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(
    tag,
  )}/${encodeURIComponent(basename)}`;
}

async function collectFiles(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    const entries = await fs
      .readdir(current, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Pairs every updater bundle with the detached signature Tauri wrote beside
 * it and returns the `platforms` map for the manifest.
 *
 * @throws when a platform's bundle exists but its `.sig` is missing.
 */
export function buildPlatforms(files, { repository, tag }) {
  const bundles = files.filter((file) => !file.endsWith(".sig"));
  const signatures = new Set(files.filter((file) => file.endsWith(".sig")));

  const platforms = {};
  const missing = [];

  for (const target of PLATFORM_TARGETS) {
    const bundle = bundles.find((file) => target.matches(path.basename(file)));
    if (!bundle) {
      continue;
    }

    const signaturePath = `${bundle}.sig`;
    if (!signatures.has(signaturePath)) {
      missing.push(path.basename(bundle));
      continue;
    }

    platforms[target.key] = {
      signature: signaturePath,
      url: assetUrl(repository, tag, path.basename(bundle)),
    };
  }

  if (missing.length > 0) {
    throw new Error(
      `Updater bundles are missing their .sig signature: ${missing.join(", ")}. ` +
        "Refusing to publish a manifest the client cannot verify.",
    );
  }

  return platforms;
}

async function main() {
  const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR ?? "dist");
  const version = process.env.RELEASE_VERSION ?? "";
  const tag = process.env.RELEASE_TAG ?? "";
  const notes = process.env.RELEASE_NOTES ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "maus-inc/mausVoice";
  const outputPath = path.resolve(process.env.OUTPUT_PATH ?? "latest.json");

  if (!version || !tag) {
    throw new Error("RELEASE_VERSION and RELEASE_TAG are required");
  }

  if (isPrerelease(process.env.RELEASE_PRERELEASE)) {
    // A prerelease must never reach stable-channel clients. The workflow
    // already guards this, so reaching here means the guard regressed.
    throw new Error("Refusing to build an updater manifest for a prerelease");
  }

  const files = await collectFiles(artifactsRoot);
  const platforms = buildPlatforms(files, { repository, tag });

  if (Object.keys(platforms).length === 0) {
    throw new Error(
      `No signed updater bundles found under ${artifactsRoot}. ` +
        "Expected .app.tar.gz, .nsis.zip, or .AppImage with matching .sig files.",
    );
  }

  // The signature field carries the file's contents, not its path.
  for (const target of Object.values(platforms)) {
    target.signature = (await fs.readFile(target.signature, "utf8")).trim();
  }

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Wrote ${outputPath} for ${version} with platforms: ${Object.keys(platforms).join(", ")}`,
  );
}

// Only run when executed directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
