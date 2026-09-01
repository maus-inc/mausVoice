import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(
  readFileSync(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
) as {
  app?: {
    security?: {
      csp?: string | null;
      dangerousDisableAssetCspModification?: boolean | string[];
    };
  };
  bundle?: {
    createUpdaterArtifacts?: boolean;
  };
  plugins?: {
    updater?: {
      endpoints?: string[];
      pubkey?: string;
    };
  };
};

const security = conf.app?.security ?? {};
const csp = security.csp ?? "";

// Emotion (MUI) injects every component style as a runtime <style> tag, so
// style-src must keep 'unsafe-inline' effective. Tauri rewrites the served
// CSP by appending nonces/hashes for the static tags in index.html, and per
// the CSP spec the presence of a nonce or hash makes browsers IGNORE
// 'unsafe-inline' — which blocked every emotion style tag and shipped a
// completely unstyled release build (0.1.6). Keeping style-src out of the
// asset CSP modification preserves 'unsafe-inline' while script-src keeps
// its hash protection.
describe("tauri.conf.json CSP contracts", () => {
  it("keeps unsafe-inline effective for style-src", () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("excludes style-src from Tauri asset CSP modification", () => {
    const disabled = security.dangerousDisableAssetCspModification;
    expect(
      disabled === true ||
        (Array.isArray(disabled) && disabled.includes("style-src")),
    ).toBe(true);
  });

  it("keeps script-src strict (no unsafe-inline scripts)", () => {
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

// The updater is a code-execution channel: whatever the manifest points at is
// downloaded and installed. Both halves of that trust chain — the public key
// that authorizes an artifact and the endpoint that names it — are therefore
// contract-tested against the live config rather than assumed.
describe("tauri.conf.json updater contracts", () => {
  const updater = conf.plugins?.updater ?? {};

  it("ships no committed trust anchor", () => {
    // A key in the repository lets anyone sign an artifact the app auto-trusts.
    // The release workflow injects the real key from secrets at build time.
    expect(updater.pubkey ?? "").toBe("");
  });

  it("does not produce updater artifacts in unsigned builds", () => {
    // Signed release runs flip this on; every other build must not emit
    // bundles that look updatable but carry a throwaway signature.
    expect(conf.bundle?.createUpdaterArtifacts).toBe(false);
  });

  it("resolves the manifest over https from the real repository", () => {
    const endpoints = updater.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);

    for (const endpoint of endpoints) {
      const url = new URL(endpoint);
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe("github.com");
      // mausvoice/mausvoice is not this project and never resolved.
      expect(url.pathname.startsWith("/maus-inc/mausVoice/")).toBe(true);
      expect(url.pathname.endsWith("/latest.json")).toBe(true);
    }
  });
});
