/**
 * Contract test: every remote host the webview contacts directly must be
 * allowed by the production CSP `connect-src` in `tauri.conf.json`.
 *
 * Why this exists: dev builds do not enforce `security.csp`, so a provider
 * host missing from `connect-src` works in `pnpm dev` and in every CI job,
 * then silently fails in the release bundle (this shipped twice: the PR #49
 * styling regression, and the AssemblyAI/xAI/Aldea/Azure connect-src gaps).
 *
 * Two layers of protection:
 *  1. A mechanical scan of provider sources for `https://` / `wss://` host
 *     literals in files that use the bare browser `fetch` / `WebSocket`
 *     (files importing `@tauri-apps/plugin-http` are exempt — that fetch is
 *     routed through Rust and governed by the `http:default` capability,
 *     not the CSP).
 *  2. A curated list of hosts that are constructed dynamically at runtime
 *     (e.g. the Azure Speech SDK's region-prefixed websocket endpoints) and
 *     therefore never appear as literals.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const tauriConf = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
    "utf8",
  ),
) as { app?: { security?: { csp?: string | null } } };

const csp = tauriConf.app?.security?.csp ?? "";
const connectSrcMatch = /connect-src ([^;]+);/.exec(csp);
const connectSources = (connectSrcMatch?.[1] ?? "")
  .split(/\s+/)
  .filter(Boolean);

/** True when `host` is allowed by a connect-src source expression list. */
const isAllowed = (scheme: string, host: string): boolean =>
  connectSources.some((source) => {
    const schemeMatch = /^(https|wss|http|ws):\/\/(.+)$/.exec(source);
    if (!schemeMatch) return false;
    const [, sourceScheme, sourceHostPort] = schemeMatch;
    if (sourceScheme !== scheme) return false;
    const sourceHost = sourceHostPort.replace(/:.*$/, "");
    if (sourceHost.startsWith("*.")) {
      return host.endsWith(sourceHost.slice(1)) && host !== sourceHost.slice(2);
    }
    return host === sourceHost;
  });

/** Hosts that appear as literals but are never contacted by the webview. */
const NON_NETWORK_HOSTS = new Set([
  // Sent as an HTTP-Referer header value (OpenRouter attribution), and used
  // in docs links — never fetched by the webview itself.
  "maus-inc.github.io",
  // Documentation URLs inside comments.
  "console.groq.com",
  "schema.tauri.app",
  // Loopback endpoints are covered by the localhost entries and are not
  // internet hosts.
  "localhost",
  "127.0.0.1",
]);

/** Directories scanned for provider host literals. */
const SCAN_DIRS = [
  "packages/voice-ai/src",
  "apps/desktop/src/sessions",
  "apps/desktop/src/repos",
  "apps/desktop/src/utils",
];

type FoundHost = { scheme: string; host: string; file: string };

const collectHosts = (): FoundHost[] => {
  const found: FoundHost[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = resolve(repoRoot, dir);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      const source = readFileSync(join(abs, entry.name), "utf8");
      // plugin-http fetch goes through Rust (http:default capability); the
      // webview CSP does not apply to it.
      if (source.includes("@tauri-apps/plugin-http")) continue;
      for (const match of source.matchAll(
        /(https|wss):\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi,
      )) {
        const scheme = match[1].toLowerCase();
        const host = match[2].toLowerCase();
        if (NON_NETWORK_HOSTS.has(host)) continue;
        found.push({ scheme, host, file: `${dir}/${entry.name}` });
      }
    }
  }
  return found;
};

describe("production CSP connect-src covers every webview-fetched provider host", () => {
  it("has a non-null CSP with a connect-src directive", () => {
    expect(csp, "security.csp must not be null in release builds").toBeTruthy();
    expect(connectSources.length).toBeGreaterThan(0);
  });

  it("allows every https/wss host literal used with bare fetch/WebSocket", () => {
    const violations = collectHosts().filter(
      ({ scheme, host }) => !isAllowed(scheme, host),
    );
    expect(
      violations,
      `Hosts fetched by the webview but missing from connect-src in tauri.conf.json:\n` +
        violations
          .map((v) => `  ${v.scheme}://${v.host} (${v.file})`)
          .join("\n") +
        `\nAdd the host to connect-src, or route the call through ` +
        `@tauri-apps/plugin-http and extend the http:default capability.`,
    ).toEqual([]);
  });

  it("allows dynamically-constructed provider endpoints", () => {
    // These hosts are built at runtime and never appear as source literals.
    const dynamicEndpoints: Array<{
      scheme: string;
      host: string;
      why: string;
    }> = [
      {
        scheme: "wss",
        host: "eastus.stt.speech.microsoft.com",
        why: "Azure Speech SDK websocket (region-prefixed, default region)",
      },
      {
        scheme: "https",
        host: "westeurope.stt.speech.microsoft.com",
        why: "Azure Speech SDK REST (any region must match the wildcard)",
      },
      {
        scheme: "https",
        host: "securetoken.googleapis.com",
        why: "Firebase auth token refresh",
      },
    ];
    for (const { scheme, host, why } of dynamicEndpoints) {
      expect(isAllowed(scheme, host), `${scheme}://${host} — ${why}`).toBe(
        true,
      );
    }
  });
});
