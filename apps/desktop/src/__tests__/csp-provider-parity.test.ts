import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(desktopRoot, relPath), "utf8"));
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      collectFiles(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

function connectSrcHosts(): Set<string> {
  const conf = readJson("src-tauri/tauri.conf.json") as {
    app: { security: { csp: string } };
  };
  const match = conf.app.security.csp.match(/connect-src ([^;]*);/);
  if (!match) throw new Error("connect-src not found in tauri.conf.json");
  const hosts = new Set<string>();
  for (const token of match[1].split(/\s+/)) {
    if (token.startsWith("https://")) hosts.add(token);
    else if (token.startsWith("wss://")) hosts.add(token.replace("wss://", "https://"));
  }
  return hosts;
}

function capabilityHosts(): Set<string> {
  const caps = readJson("src-tauri/capabilities/default.json") as {
    permissions: Array<
      | string
      | { identifier: string; allow?: Array<{ url: string }> }
    >;
  };
  const hosts = new Set<string>();
  const httpDefault = caps.permissions.find(
    (p): p is { identifier: string; allow?: Array<{ url: string }> } =>
      typeof p === "object" && p !== null && p.identifier === "http:default",
  );
  for (const entry of httpDefault?.allow ?? []) {
    const url = entry.url.replace(/\/\*\*?$/, "").replace(/:\*$/, "");
    if (url.startsWith("https://")) hosts.add(url);
  }
  return hosts;
}

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

describe("CSP / provider host parity", () => {
  const connect = connectSrcHosts();
  const capability = capabilityHosts();
  const apiHosts = sourceApiHosts();

  it("every api.* host used by a provider is allowed by connect-src", () => {
    const missing = [...apiHosts].filter((h) => !connect.has(h));
    expect(missing, `Missing from connect-src: ${missing.join(", ")}`).toEqual([]);
  });

  it("every api.* host used by a provider is allowed by the http:default capability", () => {
    const missing = [...apiHosts].filter((h) => !capability.has(h));
    expect(missing, `Missing from http:default capability: ${missing.join(", ")}`).toEqual([]);
  });

  it("the batch transcription providers are explicitly enumerated", () => {
    for (const host of [
      "https://api.assemblyai.com",
      "https://api.x.ai",
      "https://api.aldea.ai",
    ]) {
      expect(connect.has(host), `${host} must be in connect-src`).toBe(true);
      expect(capability.has(host), `${host} must be in http:default capability`).toBe(true);
    }
  });
});
