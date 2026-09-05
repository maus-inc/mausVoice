import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import {
  assetUrl,
  buildPlatforms,
  isDirectInvocation,
  isPrerelease,
} from "./build-updater-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const script = join(here, "build-updater-manifest.mjs");

const tempDirs = [];

/** Creates an artifact tree; `files` maps a relative path to its contents. */
const makeArtifacts = (files) => {
  const root = mkdtempSync(join(tmpdir(), "mausvoice-updater-"));
  tempDirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
};

const runScript = (env, scriptPath = script) => {
  const outputPath = join(
    mkdtempSync(join(tmpdir(), "mausvoice-manifest-")),
    "latest.json",
  );
  tempDirs.push(dirname(outputPath));
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OUTPUT_PATH: outputPath,
        GITHUB_REPOSITORY: "maus-inc/mausVoice",
        ...env,
      },
    });
    return { ok: true, stdout, outputPath };
  } catch (error) {
    return {
      ok: false,
      stderr: `${error.stderr ?? ""}${error.stdout ?? ""}`,
      outputPath,
    };
  }
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The signed set a normal (non-prerelease) run produces on all three
// platforms, each bundle accompanied by the .sig Tauri emits next to it.
const fullySignedArtifacts = () =>
  makeArtifacts({
    "mausvoice-macos/mausVoice.app.tar.gz": "mac-bundle",
    "mausvoice-macos/mausVoice.app.tar.gz.sig": "mac-signature\n",
    "mausvoice-windows/mausVoice_0.1.7_x64-setup.nsis.zip": "win-bundle",
    "mausvoice-windows/mausVoice_0.1.7_x64-setup.nsis.zip.sig":
      "win-signature\n",
    "mausvoice-linux/mausVoice_0.1.7_amd64.AppImage": "linux-bundle",
    "mausvoice-linux/mausVoice_0.1.7_amd64.AppImage.sig": "linux-signature\n",
  });

// Runs the builder against `artifacts` with the standard v0.1.7 release env;
// `env` overrides individual inputs (prerelease flag, notes, empty version).
const runReleaseScript = (artifacts, env = {}, scriptPath = script) =>
  runScript(
    {
      RELEASE_VERSION: "0.1.7",
      RELEASE_TAG: "mausVoice-v0.1.7",
      RELEASE_PRERELEASE: "false",
      ARTIFACTS_DIR: artifacts,
      ...env,
    },
    scriptPath,
  );

// Runs a successful build and returns the parsed manifest. The `ok`
// assertion lives here so a failing builder reports its stderr instead of a
// downstream JSON parse error.
const buildManifest = (artifacts, env = {}, scriptPath) => {
  const result = runReleaseScript(artifacts, env, scriptPath);
  assert.ok(result.ok, `script failed: ${result.stderr}`);
  return JSON.parse(readFileSync(result.outputPath, "utf8"));
};

describe("updater manifest builder", () => {
  it("emits a Tauri v2 manifest covering every supported target", () => {
    const artifacts = fullySignedArtifacts();
    const manifest = buildManifest(artifacts, {
      RELEASE_NOTES: "Fixes the updater.",
    });

    assert.equal(manifest.version, "0.1.7");
    assert.equal(manifest.notes, "Fixes the updater.");
    assert.ok(
      Number.isFinite(Date.parse(manifest.pub_date)),
      "pub_date must be a parseable ISO timestamp",
    );

    // Derive the expected key set from the manifest the client contract
    // requires: per-installer keys plus a bare fallback for each platform.
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);

    // Both macOS architectures resolve to the one universal bundle.
    assert.deepEqual(
      manifest.platforms["darwin-aarch64"],
      manifest.platforms["darwin-x86_64"],
    );

    assert.equal(
      manifest.platforms["darwin-aarch64"].signature,
      "mac-signature",
    );
    assert.equal(
      manifest.platforms["windows-x86_64"].signature,
      "win-signature",
    );
    assert.equal(
      manifest.platforms["linux-x86_64"].signature,
      "linux-signature",
    );
  });

  it("runs directly from a script path containing spaces", () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "mausvoice updater script "));
    tempDirs.push(scriptDir);
    const spacedScript = join(scriptDir, "build updater manifest.mjs");
    copyFileSync(script, spacedScript);

    const artifacts = fullySignedArtifacts();
    const manifest = buildManifest(artifacts, {}, spacedScript);
    assert.equal(manifest.version, "0.1.7");
    assert.ok(Object.keys(manifest.platforms).length > 0);
  });

  it("points every platform at the release tag on the real repository", () => {
    const artifacts = fullySignedArtifacts();
    const manifest = buildManifest(artifacts);

    for (const [key, target] of Object.entries(manifest.platforms)) {
      const url = new URL(target.url);
      assert.equal(url.protocol, "https:", `${key} must download over https`);
      assert.equal(
        url.host,
        "github.com",
        `${key} must download from github.com`,
      );
      assert.ok(
        url.pathname.startsWith("/maus-inc/mausVoice/releases/download/"),
        `${key} must resolve against maus-inc/mausVoice, got ${url.pathname}`,
      );
      assert.ok(
        url.pathname.includes("mausVoice-v0.1.7"),
        `${key} must reference the release tag, got ${url.pathname}`,
      );
    }
  });

  it("emits per-installer keys for real v2 Windows artifacts (.msi + .exe)", () => {
    // This is exactly the artifact set the direct-sign release job produces.
    // The original builder only ever emitted a bare `windows-x86_64` from a
    // `.nsis.zip`, so the NSIS installer was unreachable — this would have
    // caught that 🔴 regression.
    const artifacts = makeArtifacts({
      "win/mausVoice_0.1.7_x64_en-US.msi": "msi-bundle",
      "win/mausVoice_0.1.7_x64_en-US.msi.sig": "msi-signature\n",
      "win/mausVoice_0.1.7_x64-setup.exe": "nsis-bundle",
      "win/mausVoice_0.1.7_x64-setup.exe.sig": "nsis-signature\n",
    });
    const manifest = buildManifest(artifacts);

    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    // The bare fallback must point at the MSI (higher precedence).
    assert.equal(
      manifest.platforms["windows-x86_64"].signature,
      "msi-signature",
    );
    assert.equal(
      manifest.platforms["windows-x86_64-msi"].signature,
      "msi-signature",
    );
    assert.equal(
      manifest.platforms["windows-x86_64-nsis"].signature,
      "nsis-signature",
    );
  });

  it("publishes the signed Linux AppImage and ignores unsigned .deb/.rpm", () => {
    // Tauri v2 direct-signs the AppImage but does NOT emit a `.sig` for
    // `.deb`/`.rpm`. Those are ordinary release installers and must not be
    // placed in the updater manifest (which would otherwise reject the release
    // for a missing `.deb.sig`). The manifest must succeed and only contain
    // the AppImage-derived keys.
    const artifacts = makeArtifacts({
      "linux/mausVoice_0.1.7_amd64.AppImage": "appimage-bundle",
      "linux/mausVoice_0.1.7_amd64.AppImage.sig": "appimage-signature\n",
      "linux/mausVoice_0.1.7_amd64.deb": "deb-bundle",
      "linux/mausVoice_0.1.7_amd64.rpm": "rpm-bundle",
    });
    const manifest = buildManifest(artifacts);

    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
    assert.equal(
      manifest.platforms["linux-x86_64-appimage"].signature,
      "appimage-signature",
    );
    assert.ok(
      !("linux-x86_64-deb" in manifest.platforms),
      "unsigned .deb must not appear as an updater bundle",
    );
    assert.ok(
      !("linux-x86_64-rpm" in manifest.platforms),
      "unsigned .rpm must not appear as an updater bundle",
    );
  });

  it("emits .app.tar.gz and .dmg keys for macOS", () => {
    const artifacts = makeArtifacts({
      "mac/mausVoice.app.tar.gz": "mac-app-bundle",
      "mac/mausVoice.app.tar.gz.sig": "mac-app-signature\n",
      "mac/mausVoice_0.1.7_universal.dmg": "mac-dmg-bundle",
      "mac/mausVoice_0.1.7_universal.dmg.sig": "mac-dmg-signature\n",
    });
    const manifest = buildManifest(artifacts);

    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-aarch64-dmg",
      "darwin-x86_64",
      "darwin-x86_64-dmg",
    ]);
    // The universal .app.tar.gz is the bare darwin key; the .dmg is separate.
    assert.equal(
      manifest.platforms["darwin-aarch64"].signature,
      "mac-app-signature",
    );
    assert.equal(
      manifest.platforms["darwin-aarch64-dmg"].signature,
      "mac-dmg-signature",
    );
    assert.deepEqual(
      manifest.platforms["darwin-aarch64"],
      manifest.platforms["darwin-x86_64"],
    );
  });

  it("refuses to publish a bundle whose signature is missing", () => {
    const artifacts = makeArtifacts({
      "mac/mausVoice.app.tar.gz": "mac-bundle",
      "mac/mausVoice.app.tar.gz.sig": "mac-signature\n",
      // The Windows bundle built but was never signed.
      "win/mausVoice_0.1.7_x64-setup.nsis.zip": "win-bundle",
    });

    const result = runReleaseScript(artifacts);

    assert.equal(result.ok, false, "expected a non-zero exit");
    assert.match(result.stderr, /missing their \.sig signature/);
    assert.match(result.stderr, /nsis\.zip/);
  });

  it("fails when no signed updater bundle exists at all", () => {
    const artifacts = makeArtifacts({
      "mac/README.txt": "not an installer",
      "linux/notes.md": "not an installer",
    });

    const result = runReleaseScript(artifacts);

    assert.equal(result.ok, false, "expected a non-zero exit");
    assert.match(result.stderr, /No signed updater bundles found/);
  });

  it("never builds a manifest for a prerelease", () => {
    const artifacts = fullySignedArtifacts();
    const result = runReleaseScript(artifacts, {
      RELEASE_VERSION: "0.2.0-rc.1",
      RELEASE_TAG: "mausVoice-v0.2.0-rc.1",
      RELEASE_PRERELEASE: "true",
    });

    assert.equal(result.ok, false, "expected a non-zero exit");
    assert.match(result.stderr, /prerelease/);
  });

  it("requires the version and tag inputs", () => {
    const artifacts = fullySignedArtifacts();
    const result = runReleaseScript(artifacts, {
      RELEASE_VERSION: "",
      RELEASE_TAG: "",
    });

    assert.equal(result.ok, false, "expected a non-zero exit");
    assert.match(result.stderr, /RELEASE_VERSION and RELEASE_TAG are required/);
  });
});

describe("updater manifest helpers", () => {
  it("recognizes encoded spaces and Windows drive-letter invocation paths", () => {
    const nativePath = join(
      tmpdir(),
      "mausVoice updater",
      "build updater manifest.mjs",
    );
    assert.equal(
      isDirectInvocation(pathToFileURL(nativePath).href, nativePath),
      true,
    );

    const windowsPath = String.raw`C:\Program Files\mausVoice\build updater manifest.mjs`;
    assert.equal(
      isDirectInvocation(
        "file:///C:/Program%20Files/mausVoice/build%20updater%20manifest.mjs",
        windowsPath,
        true,
      ),
      true,
    );
    assert.equal(isDirectInvocation(import.meta.url, undefined), false);
  });

  it('treats only the literal string "true" as a prerelease', () => {
    // "false" is truthy in Node, which is exactly the trap this guards.
    assert.equal(isPrerelease("true"), true);
    assert.equal(isPrerelease("false"), false);
    assert.equal(isPrerelease(undefined), false);
    assert.equal(isPrerelease(""), false);
  });

  it("percent-encodes tags and basenames in download URLs", () => {
    const url = assetUrl(
      "maus-inc/mausVoice",
      "mausVoice-v0.1.7",
      "mausVoice 0.1.7.AppImage",
    );
    assert.ok(
      url.startsWith(
        "https://github.com/maus-inc/mausVoice/releases/download/",
      ),
    );
    assert.ok(!url.includes(" "), "spaces must be encoded");
  });

  it("reports every unsigned bundle in one error rather than the first", () => {
    assert.throws(
      () =>
        buildPlatforms(
          [
            "/tmp/mausVoice.app.tar.gz",
            "/tmp/mausVoice_x64-setup.nsis.zip",
            "/tmp/mausVoice_amd64.AppImage",
          ],
          { repository: "maus-inc/mausVoice", tag: "mausVoice-v0.1.7" },
        ),
      (error) =>
        /app\.tar\.gz/.test(error.message) &&
        /nsis\.zip/.test(error.message) &&
        /AppImage/.test(error.message),
    );
  });
});
