import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is <repo>/apps/desktop/src/__tests__, so the desktop app root is two
// levels up (src/__tests__ -> src -> apps/desktop).
const desktopRoot = resolve(here, "..", "..");

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(desktopRoot, relPath), "utf8"));
}

describe("http:default capability contract", () => {
  const caps = readJson("src-tauri/capabilities/default.json") as {
    permissions: Array<
      string | { identifier: string; allow?: Array<{ url: string }> }
    >;
  };

  const httpDefault = caps.permissions.find(
    (p): p is { identifier: string; allow?: Array<{ url: string }> } =>
      typeof p === "object" && p !== null && p.identifier === "http:default",
  );

  const allowUrls = (httpDefault?.allow ?? []).map((entry) => entry.url);

  it("exposes http://*:* for user-configured base URLs", () => {
    // Self-hosted/Ollama/OpenAI-compatible endpoints are user-configured
    // (LAN boxes, reverse proxies, arbitrary ports) and cannot be enumerated
    // at build time, so http must stay a wildcard.
    expect(allowUrls, "http:default capability must exist").toContain(
      "http://*:*",
    );
  });

  it("does not allow https://* (hosted SaaS stays a curated allow-list)", () => {
    // A https://* wildcard would let injected page script exfiltrate to any
    // TLS host through Rust, sidestepping the webview CSP entirely.
    expect(
      allowUrls,
      "https://* must not be wildcarded in http:default",
    ).not.toContain("https://*");
  });
});
