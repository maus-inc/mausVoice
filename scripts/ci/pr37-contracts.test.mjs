import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const source = {
  custom404: read("apps/docs/src/pages/404.astro"),
  navigationDocs: read("apps/docs/src/content/docs/reference/navigation.md"),
  onboardingDocs: read(
    "apps/docs/src/content/docs/getting-started/onboarding.md",
  ),
  tauriBackendDocs: read(
    "apps/docs/src/content/docs/development/tauri-backend.md",
  ),
};

describe("PR37 active local-profile documentation contracts", () => {
  it("documents personal authentication without presenting legacy login as active", () => {
    assert.match(
      source.onboardingDocs,
      /initializes a local personal profile automatically/,
    );
    assert.match(source.onboardingDocs, /not an active authentication path/);
    assert.doesNotMatch(
      source.onboardingDocs,
      /whether you choose account sign-in or local\/personal setup/,
    );

    assert.match(
      source.navigationDocs,
      /no guard transition targets `\/login`/,
    );
    assert.match(source.navigationDocs, /retained legacy implementation/);
    assert.doesNotMatch(
      source.navigationDocs,
      /guards can send a profile to `\/welcome`, `\/login`/,
    );
  });

  it("does not assign removed authentication ownership to Rust system modules", () => {
    assert.match(source.tauriBackendDocs, /has no authentication module/);
    assert.doesNotMatch(
      source.tauriBackendDocs,
      /`system\/` owns[^\n]*\bauth\b/,
    );
  });
});

describe("PR37 generated release-body contracts", () => {
  it("renders provider calls to action as ordinary Markdown links", () => {
    for (const prerelease of [false, true]) {
      const artifactsDir = mkdtempSync(
        resolve(tmpdir(), "mausvoice-release-body-"),
      );

      try {
        const body = execFileSync(
          process.execPath,
          [resolve(repoRoot, "scripts/ci/generate-release-body.mjs")],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              ARTIFACTS_DIR: artifactsDir,
              GITHUB_REPOSITORY: "maus-inc/mausVoice",
              RELEASE_NAME: "mausVoice v0.1.6",
              RELEASE_NOTES: "Contract-test release notes",
              RELEASE_PRERELEASE: String(prerelease),
              RELEASE_TAG: "mausVoice-v0.1.6",
              RELEASE_VERSION: "0.1.6",
            },
          },
        );

        assert.match(
          body,
          /\[Free Groq↗\]\(https:\/\/console\.groq\.com\/keys\)/,
        );
        assert.match(
          body,
          /\[Free Deepgram↗\]\(https:\/\/console\.deepgram\.com\/\)/,
        );
        assert.equal(
          body.match(/https:\/\/console\.groq\.com\/keys/g)?.length,
          1,
        );
        assert.equal(
          body.match(/https:\/\/console\.deepgram\.com\//g)?.length,
          1,
        );
        assert.doesNotMatch(body, /\]\(\[https?:\/\//);
        assert.match(
          body,
          prerelease ? /unsigned pre-release/ : /Unsigned, self-built binaries/,
        );
      } finally {
        rmSync(artifactsDir, { force: true, recursive: true });
      }
    }
  });
});

describe("PR37 custom 404 contracts", () => {
  it("keeps keyboard, motion, responsive, and asset behavior wired", () => {
    assert.match(source.custom404, /class="skip" href="#content"/);
    assert.match(source.custom404, /:focus-visible/);
    assert.match(source.custom404, /aria-label="404 navigation"/);
    assert.match(source.custom404, /aria-label="Page not found status"/);
    assert.match(source.custom404, /@media \(max-width: 780px\)/);
    assert.match(source.custom404, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(source.custom404, /animation: none !important/);
    assert.match(source.custom404, /const base = "\/mausVoice\/docs\/"/);

    for (const asset of [
      "assets/404/hero-bg.jpg",
      "assets/404/ascii-term.png",
      "assets/404/footer-ascii.png",
      "assets/404/logo.png",
      "assets/fonts/Satoshi-Medium.ttf",
      "assets/fonts/TAN-PARADISO-Regular.woff2",
      "assets/fonts/jetbrains-mono-latin-400-normal.woff2",
    ]) {
      assert.equal(
        statSync(resolve(repoRoot, "apps/docs/public", asset)).isFile(),
        true,
        `missing custom 404 asset: ${asset}`,
      );
    }
  });
});
