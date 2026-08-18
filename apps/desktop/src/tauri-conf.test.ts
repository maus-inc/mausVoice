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
