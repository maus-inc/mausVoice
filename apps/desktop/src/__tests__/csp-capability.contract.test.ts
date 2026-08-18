import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is <repo>/apps/desktop/src/__tests__, so the desktop app root is two
// levels up (src/__tests__ -> src -> apps/desktop) and the repo root two more.
const desktopRoot = resolve(here, "..", "..");
const repoRoot = resolve(desktopRoot, "..", "..");

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(desktopRoot, relPath), "utf8"));
}

/** The `allow` URLs from the `http:default` capability (plugin-http scope). */
function httpDefaultAllow(): { url: string }[] {
  const caps = readJson("src-tauri/capabilities/default.json") as {
    permissions: Array<
      string | { identifier: string; allow?: Array<{ url: string }> }
    >;
  };
  const httpDefault = caps.permissions.find(
    (p): p is { identifier: string; allow?: Array<{ url: string }> } =>
      typeof p === "object" && p !== null && p.identifier === "http:default",
  );
  return httpDefault?.allow ?? [];
}

const allowUrls = httpDefaultAllow().map((entry) => entry.url);

/** https:// host origins parsed out of the http:default allow list. */
const capabilityHosts = new Set(
  allowUrls
    .map((url) => url.replace(/\/\*\*?$/, "").replace(/:\*$/, ""))
    .filter((url) => url.startsWith("https://")),
);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git")
        continue;
      collectFiles(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every `https://api.*` host literal in the provider source trees. */
function sourceApiHosts(): Set<string> {
  const roots = [
    resolve(repoRoot, "packages/voice-ai/src"),
    resolve(desktopRoot, "src/sessions"),
  ];
  const hosts = new Set<string>();
  const apiRe = /https:\/\/api\.[a-z0-9.-]+/g;
  for (const root of roots) {
    for (const file of collectFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(apiRe)) {
        hosts.add(m[0]);
      }
    }
  }
  return hosts;
}

const apiHosts = sourceApiHosts();

describe("http:default capability contract", () => {
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

  it("allows every api.* provider host via the http:default capability", () => {
    // Provider calls routed through @tauri-apps/plugin-http are executed in
    // Rust and governed by the http:default capability, NOT the webview CSP
    // connect-src. This is the capability-side mirror of the connect-src
    // contract in `../csp-connect-src.contract.test.ts` (that file's host
    // literal scan already guarantees these hosts in connect-src; this
    // guarantees them in the capability so the Rust-side fetch is permitted).
    const missing = [...apiHosts].filter((h) => !capabilityHosts.has(h));
    expect(
      missing,
      `Missing from http:default capability: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("enumerates the batch transcription providers in http:default", () => {
    // Defense-in-depth: these are the providers historically dropped from
    // connect-src (see ../csp-connect-src.contract.test.ts). Hard-coding them
    // means a refactor that stops using them as literals can't silently drop
    // the capability entry. (Their connect-src parity is asserted by the
    // canonical csp-connect-src contract test, not duplicated here.)
    for (const host of [
      "https://api.assemblyai.com",
      "https://api.x.ai",
      "https://api.aldea.ai",
    ]) {
      expect(
        capabilityHosts.has(host),
        `${host} must be in http:default capability`,
      ).toBe(true);
    }
  });
});
