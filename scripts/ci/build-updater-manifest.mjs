#!/usr/bin/env node

// Builds the Tauri v2 updater manifest (`latest.json`) from the installers a
// release run produced.
//
// Reads:
//   ARTIFACTS_DIR      - downloaded artifact root (dist/)
//   RELEASE_VERSION    - e.g. 0.1.3
//   RELEASE_TAG        - e.g. mausVoice-v0.1.3
//   RELEASE_NOTES_FILE - normalized notes shared with body/changelog
//   RELEASE_NOTES      - inline fallback for standalone invocations
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
import { collectArtifactFiles } from "./artifact-files.mjs";
import { runIfDirect } from "./script-entry.mjs";
export { isDirectInvocation } from "./script-entry.mjs";
import { readReleaseNotes } from "./release-notes.mjs";

// Tauri resolves an installer URL by `{os}-{arch}-{installer}` first and then
// falls back to the bare `{os}-{arch}` key. The release job builds with
// `createUpdaterArtifacts: true`, which emits a *direct-sign* bundle per
// updater artifact type: Windows `.msi`/`.exe`/`.nsis.zip`, Linux `.AppImage`,
// and macOS `.app.tar.gz` (the actual updater bundle) plus `.dmg`. The `.dmg`
// is signed explicitly by the release job; the others are signed by Tauri's
// updater. Emitting the per-installer keys *and* a bare fallback makes the
// manifest correct regardless of which key Tauri prefers for a given platform.
//
// `.deb`/`.rpm` are intentionally NOT listed here: Tauri v2 does not produce
// detached `.sig` files for them, so they must not appear as updater bundles
// in `latest.json` (doing so would make manifest generation reject the release
// for a missing `.deb.sig`). They are still built and published as ordinary
// release installers via the upload step.
//
// Each entry declares the filename matcher, the manifest keys it produces, and
// (for platforms that need one) the bare fallback key. `barePrecedence`
// decides which installer wins the bare fallback when several are present
// (lower number wins): MSI over NSIS, AppImage for Linux.
const INSTALLER_TYPES = [
  {
    id: "mac-app",
    match: (name) => name.endsWith(".app.tar.gz"),
    keys: () => ["darwin-aarch64", "darwin-x86_64"],
  },
  {
    id: "mac-dmg",
    match: (name) => name.toLowerCase().endsWith(".dmg"),
    keys: () => ["darwin-aarch64-dmg", "darwin-x86_64-dmg"],
  },
  {
    id: "win-msi",
    match: (name) =>
      name.toLowerCase().endsWith(".msi") ||
      name.toLowerCase().endsWith(".msi.zip"),
    keys: () => ["windows-x86_64-msi"],
    bare: "windows-x86_64",
    barePrecedence: 0,
  },
  {
    id: "win-nsis",
    match: (name) =>
      name.toLowerCase().endsWith(".exe") ||
      name.toLowerCase().endsWith(".nsis.zip"),
    keys: () => ["windows-x86_64-nsis"],
    bare: "windows-x86_64",
    barePrecedence: 1,
  },
  {
    id: "lin-appimage",
    match: (name) =>
      name.toLowerCase().endsWith(".appimage") ||
      name.toLowerCase().endsWith(".appimage.tar.gz"),
    keys: () => ["linux-x86_64-appimage"],
    bare: "linux-x86_64",
    barePrecedence: 0,
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

/**
 * Pairs every updater bundle with the detached signature Tauri wrote beside
 * it and returns the `platforms` map for the manifest.
 *
 * @throws when a platform's bundle exists but its `.sig` is missing.
 */
/** Release assets are uploaded by basename, so collisions cannot be addressed safely. */
function assertUniqueUpdaterBasenames(bundles) {
  const seen = new Map();
  for (const file of bundles) {
    if (!INSTALLER_TYPES.some((type) => type.match(path.basename(file))))
      continue;
    const basename = path.basename(file);
    if (seen.has(basename) && seen.get(basename) !== file) {
      throw new Error(`Duplicate updater asset basename: ${basename}`);
    }
    seen.set(basename, file);
  }
}

/** Read each selected detached signature before publishing the manifest. */
async function resolveSignatures(platforms) {
  const signatures = new Map();
  for (const target of Object.values(platforms)) {
    const signaturePath = target.signature;
    if (!signatures.has(signaturePath)) {
      const signature = (await fs.readFile(signaturePath, "utf8")).trim();
      if (!signature)
        throw new Error(`Empty updater signature: ${signaturePath}`);
      signatures.set(signaturePath, signature);
    }
    target.signature = signatures.get(signaturePath);
  }
}

/** Prefer a signed bundle, while retaining diagnostics for unsigned-only types. */
function signedBundleForType(type, bundles, signatures, missing) {
  const candidates = bundles.filter((file) => type.match(path.basename(file)));
  const bundle = candidates.find((file) => signatures.has(`${file}.sig`));
  if (!bundle && candidates.length)
    missing.push(...candidates.map((file) => path.basename(file)));
  return bundle;
}

/** The documented precedence keeps fallback selection independent of file order. */
function recordBareCandidate(type, entry, bareCandidates) {
  if (!type.bare) return;
  const existing = bareCandidates[type.bare];
  if (!existing || type.barePrecedence < existing.precedence) {
    bareCandidates[type.bare] = { precedence: type.barePrecedence, entry };
  }
}

export function buildPlatforms(files, { repository, tag }) {
  const bundles = files.filter((file) => !file.endsWith(".sig"));
  const signatures = new Set(files.filter((file) => file.endsWith(".sig")));
  assertUniqueUpdaterBasenames(bundles);

  const platforms = {};
  // Bare fallback candidates: bareKey -> { precedence, entry }. The lowest
  // precedence installer present wins (see INSTALLER_TYPES).
  const bareCandidates = {};
  const missing = [];

  for (const type of INSTALLER_TYPES) {
    const bundle = signedBundleForType(type, bundles, signatures, missing);
    if (!bundle) continue;

    const signaturePath = `${bundle}.sig`;

    const entry = {
      signature: signaturePath,
      url: assetUrl(repository, tag, path.basename(bundle)),
    };

    for (const key of type.keys()) {
      platforms[key] = { ...entry };
    }

    recordBareCandidate(type, entry, bareCandidates);
  }

  // Apply the bare fallbacks last so they never clobber a per-installer key.
  // Copy the entry so the shared object isn't mutated by later steps.
  for (const [bareKey, { entry }] of Object.entries(bareCandidates)) {
    platforms[bareKey] = { ...entry };
  }

  if (missing.length > 0) {
    throw new Error(
      `Updater bundles are missing their .sig signature: ${missing.join(", ")}. ` +
        "Refusing to publish a manifest the client cannot verify.",
    );
  }

  return platforms;
}

function validateReleaseInputs(version, tag, outputPath) {
  if (!version || !tag) {
    throw new Error("RELEASE_VERSION and RELEASE_TAG are required");
  }

  if (
    isPrerelease(process.env.RELEASE_PRERELEASE) &&
    path.basename(outputPath) !== "latest-beta.json"
  ) {
    // A prerelease must never reach stable-channel clients. The explicit
    // beta-channel output (latest-beta.json) is the one intentional
    // prerelease artifact and is allowed through.
    throw new Error("Refusing to build an updater manifest for a prerelease");
  }
}

/** Validate release-channel inputs before reading or writing artifacts. */
function releaseInputs() {
  const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR ?? "dist");
  const version = process.env.RELEASE_VERSION ?? "";
  const tag = process.env.RELEASE_TAG ?? "";
  // GitHub Actions always sets GITHUB_REPOSITORY, so the fallback only applies
  // to local runs and fixture tests. It is intentionally the upstream repo
  // because shipped clients resolve latest.json from maus-inc/mausVoice — but
  // note the limitation: a fork running this script outside Actions would emit
  // download URLs pointing at upstream releases, not its own. Set
  // GITHUB_REPOSITORY explicitly when building a fork's manifest by hand.
  const repository = process.env.GITHUB_REPOSITORY ?? "maus-inc/mausVoice";
  const outputPath = path.resolve(process.env.OUTPUT_PATH ?? "latest.json");

  validateReleaseInputs(version, tag, outputPath);

  return { artifactsRoot, version, tag, repository, outputPath };
}

async function main() {
  const { artifactsRoot, version, tag, repository, outputPath } =
    releaseInputs();
  const notes = await readReleaseNotes();
  const files = await collectArtifactFiles(artifactsRoot);
  const platforms = buildPlatforms(files, { repository, tag });

  if (Object.keys(platforms).length === 0) {
    throw new Error(
      `No signed updater bundles found under ${artifactsRoot}. ` +
        "Expected at least one supported signed bundle (.app.tar.gz, .msi, .msi.zip, .exe, .nsis.zip, .AppImage, .AppImage.tar.gz, or .dmg) with a matching .sig; DEB/RPM are not part of the updater payload.",
    );
  }

  // The signature field carries the file's contents, not its path.
  await resolveSignatures(platforms);

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

// Run only for direct invocation; imports expose the helpers without side effects.
await runIfDirect(import.meta.url, main);
