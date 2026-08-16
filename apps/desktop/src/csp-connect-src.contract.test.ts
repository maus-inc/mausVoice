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
 *  1. A mechanical scan of the full `apps/desktop/src` and
 *     `packages/voice-ai/src` trees for `http(s)://` / `ws(s)://` host
 *     literals in files that use the bare browser `fetch` / `WebSocket`
 *     (files importing `@tauri-apps/plugin-http` are exempt — that fetch is
 *     routed through Rust and governed by the `http:default` capability,
 *     not the CSP). Hosts that are *not* network targets (openUrl links,
 *     iframe embeds, doc comments) must be explicitly classified in
 *     NON_CONNECT_HOSTS with a reason — an unknown host fails the test so
 *     the decision can never happen by omission.
 *  2. A curated list of hosts that are constructed dynamically at runtime
 *     (e.g. the Azure Speech SDK's region-prefixed websocket endpoints) and
 *     therefore never appear as literals.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const tauriConf = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
    "utf8",
  ),
) as { app?: { security?: { csp?: string | null } } };

const csp = tauriConf.app?.security?.csp ?? "";

const directiveSources = (directive: string): string[] => {
  const match = new RegExp(`${directive} ([^;]+);`).exec(csp);
  return (match?.[1] ?? "").split(/\s+/).filter(Boolean);
};

const connectSources = directiveSources("connect-src");
const frameSources = directiveSources("frame-src");

/** True when `scheme://host` is allowed by a source expression list. */
const isAllowed = (scheme: string, host: string, sources: string[]): boolean =>
  sources.some((source) => {
    const schemeMatch = /^(https?|wss?):\/\/(.+)$/.exec(source);
    if (!schemeMatch) return false;
    const [, sourceScheme, sourceHostPort] = schemeMatch;
    if (sourceScheme !== scheme) return false;
    const sourceHost = sourceHostPort.replace(/:.*$/, "");
    if (sourceHost.startsWith("*.")) {
      return host.endsWith(sourceHost.slice(1)) && host !== sourceHost.slice(2);
    }
    return host === sourceHost;
  });

/**
 * Host literals that appear in scanned sources but are NOT connect-src
 * targets. Every entry needs a reason; adding one is an explicit decision,
 * mirroring the NON_USER_DATA_TABLES pattern in commands.rs. An unlisted,
 * unallowed host fails the test.
 */
const NON_CONNECT_HOSTS = new Map<string, string>([
  // Opened in the external browser via @tauri-apps/plugin-opener (openUrl),
  // never fetched by the webview.
  ["console.deepgram.com", "openUrl external-browser link"],
  ["console.groq.com", "openUrl external-browser link / doc comment"],
  ["maus-inc.github.io", "openUrl link + OpenRouter HTTP-Referer header value"],
  // <iframe> embeds are governed by frame-src, asserted separately below.
  ["www.youtube.com", "iframe embed — validated against frame-src"],
  ["www.youtube-nocookie.com", "iframe embed — validated against frame-src"],
  // Documentation-only strings.
  ["firebase.google.com", "doc comment URL"],
  ["schema.tauri.app", "JSON $schema reference"],
]);

/** Directory trees scanned for webview-fetched host literals. */
const SCAN_ROOTS = ["apps/desktop/src", "packages/voice-ai/src"];

type FoundHost = { scheme: string; host: string; file: string };

const collectHosts = (): FoundHost[] => {
  const found: FoundHost[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      const source = readFileSync(abs, "utf8");
      // plugin-http fetch goes through Rust (http:default capability); the
      // webview CSP does not apply to it.
      if (source.includes("@tauri-apps/plugin-http")) continue;
      for (const match of source.matchAll(
        /(https?|wss?):\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi,
      )) {
        const scheme = match[1].toLowerCase();
        const host = match[2].toLowerCase();
        if (NON_CONNECT_HOSTS.has(host)) continue;
        found.push({ scheme, host, file: relative(repoRoot, abs) });
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(resolve(repoRoot, root));
  return found;
};

describe("production CSP connect-src covers every webview-fetched provider host", () => {
  it("has a non-null CSP with a connect-src directive", () => {
    expect(csp, "security.csp must not be null in release builds").toBeTruthy();
    expect(connectSources.length).toBeGreaterThan(0);
  });

  it("allows every http/https/ws/wss host literal used with bare fetch/WebSocket", () => {
    const violations = collectHosts().filter(
      ({ scheme, host }) => !isAllowed(scheme, host, connectSources),
    );
    expect(
      violations,
      `Hosts fetched by the webview but missing from connect-src in tauri.conf.json:\n` +
        violations
          .map((v) => `  ${v.scheme}://${v.host} (${v.file})`)
          .join("\n") +
        `\nAdd the host to connect-src, route the call through ` +
        `@tauri-apps/plugin-http and extend the http:default capability, or — ` +
        `only if it is genuinely not a connect-src target (openUrl link, ` +
        `iframe, comment) — classify it in NON_CONNECT_HOSTS with a reason.`,
    ).toEqual([]);
  });

  it("allows iframe embed hosts via frame-src", () => {
    for (const host of ["www.youtube.com", "www.youtube-nocookie.com"]) {
      expect(
        isAllowed("https", host, frameSources),
        `https://${host} is embedded as an iframe and must be in frame-src`,
      ).toBe(true);
    }
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
      {
        scheme: "wss",
        host: "mausvoice-prod-default-rtdb.firebaseio.com",
        why: "Firebase RTDB websocket upgrade from the https databaseURL",
      },
    ];
    for (const { scheme, host, why } of dynamicEndpoints) {
      expect(
        isAllowed(scheme, host, connectSources),
        `${scheme}://${host} — ${why}`,
      ).toBe(true);
    }
  });

  it("keeps NON_CONNECT_HOSTS entries honest (no stale exemptions)", () => {
    // Every exempted host must still appear somewhere in the scanned trees;
    // a stale entry would silently mask a future genuine fetch to that host.
    const allSources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          allSources.push(readFileSync(abs, "utf8"));
        }
      }
    };
    for (const root of SCAN_ROOTS) walk(resolve(repoRoot, root));
    const corpus = allSources.join("\n");
    const stale = [...NON_CONNECT_HOSTS.keys()].filter(
      (host) => host !== "schema.tauri.app" && !corpus.includes(host),
    );
    expect(
      stale,
      `NON_CONNECT_HOSTS entries no longer referenced anywhere — remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
