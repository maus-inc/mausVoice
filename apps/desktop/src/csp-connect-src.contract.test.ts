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
 *  1. A mechanical scan of `apps/desktop/src` plus every workspace package's
 *     `src` tree (globbed from `packages`, never hardcoded, so coverage
 *     cannot silently shrink when a package is added) for `http(s)://` /
 *     `ws(s)://` host literals.
 *     Conservatively scans plugin-http call arguments as well: nested
 *     expressions can make webview requests even inside a Rust-side call.
 *     A plugin-only host can be classified explicitly if necessary. Hosts that
 *     are *not* network targets (openUrl links, iframe embeds, doc comments)
 *     must be explicitly classified in NON_CONNECT_HOSTS (or, when they only
 *     live outside the scanned sources, KNOWN_NON_SOURCE_REFS) with a
 *     reason — an unknown host fails the test so the decision can never
 *     happen by omission.
 *  2. A curated list of hosts that are constructed dynamically at runtime
 *     (e.g. the Azure Speech SDK's region-prefixed websocket endpoints) and
 *     therefore never appear as literals.
 *
 *  This file is the authoritative *connect-src* contract. The companion
 *  `src/__tests__/csp-capability.contract.test.ts` is the authoritative
 *  *http:default capability* contract (the Rust-side mirror: hosts routed
 *  through @tauri-apps/plugin-http are governed there, not by connect-src).
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSourceFiles,
  contractSourceRoots,
} from "./__tests__/source-tree.test-utils";

const repoRoot = resolve(__dirname, "../../..");

const tauriConfRaw = readFileSync(
  resolve(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"),
  "utf8",
);

const tauriConf = JSON.parse(tauriConfRaw) as {
  app?: { security?: { csp?: string | null } };
};

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
  [
    "www.w3.org",
    "SVG xmlns namespace identifier inside an inline SVG markup string (preview runtime) — never fetched",
  ],
  ["console.groq.com", "openUrl external-browser link / doc comment"],
  ["maus-inc.github.io", "openUrl link + OpenRouter HTTP-Referer header value"],
  // Never fetched by the webview: doc links, XML namespaces, and the fatal
  // error overlay's copy of the custom protocol origin.
  ["tauri.localhost", "fatal-error overlay text naming the app's own origin"],
  // Documentation-only strings.
  ["firebase.google.com", "doc comment URL"],
  ["api-docs.deepseek.com", "doc comment URL"],
  ["inference-docs.cerebras.ai", "doc comment URL"],
  ["ai.google.dev", "doc comment URL"],
]);

/**
 * Exempt hosts that are referenced only from files the source scan never
 * reads (Tauri config, JSON `$schema` keys), so the staleness check below
 * validates them against `tauri.conf.json` instead of the scanned trees.
 * Same contract as NON_CONNECT_HOSTS: every entry needs a reason, and a
 * no-longer-referenced entry fails the test.
 */
const KNOWN_NON_SOURCE_REFS = new Map<string, string>([
  ["schema.tauri.app", "JSON $schema reference in tauri.conf.json"],
]);

/** Every host exempt from the connect-src requirement, with its reason. */
const EXEMPT_HOSTS = new Map<string, string>([
  ...NON_CONNECT_HOSTS,
  ...KNOWN_NON_SOURCE_REFS,
]);

/** Scan the same fail-closed production source tree as the capability contract. */
const scannedFiles = (): string[] =>
  contractSourceRoots(repoRoot, resolve(repoRoot, "apps/desktop")).flatMap(
    collectSourceFiles,
  );

type FoundHost = { scheme: string; host: string; file: string };

const sourceHosts = (source: string): Array<{ scheme: string; host: string }> =>
  Array.from(
    source.matchAll(/(https?|wss?):\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi),
    (match) => ({
      scheme: match[1].toLowerCase(),
      host: match[2].toLowerCase(),
    }),
  );

const collectHosts = (): FoundHost[] => {
  const found: FoundHost[] = [];
  for (const abs of scannedFiles()) {
    const source = readFileSync(abs, "utf8");
    for (const { scheme, host } of sourceHosts(source)) {
      if (EXEMPT_HOSTS.has(host)) continue;
      found.push({ scheme, host, file: relative(repoRoot, abs) });
    }
  }
  return found;
};

describe("production CSP connect-src covers every webview-fetched provider host", () => {
  it("has a non-null CSP with a connect-src directive", () => {
    expect(csp, "security.csp must not be null in release builds").toBeTruthy();
    expect(connectSources.length).toBeGreaterThan(0);
  });

  it("allows every unclassified http/https/ws/wss host literal", () => {
    const violations = collectHosts().filter(
      ({ scheme, host }) => !isAllowed(scheme, host, connectSources),
    );
    // One template literal rather than an eight-way `+` chain: the failure
    // message reads as prose, and the only computed part is the host list.
    const advice =
      "Add a hosted HTTPS provider to connect-src and the curated " +
      "http:default capability; route user-configured private HTTP through " +
      "secureFetch/private_http_request instead of a capability hostname glob; or — " +
      "only if it is genuinely not a connect-src target (openUrl link, " +
      "iframe, comment) — classify it in NON_CONNECT_HOSTS (or " +
      "KNOWN_NON_SOURCE_REFS) with a reason.";
    expect(
      violations,
      `Hosts fetched by the webview but missing from connect-src in tauri.conf.json:
${violations.map((v) => `  ${v.scheme}://${v.host} (${v.file})`).join("\n")}
${advice}`,
    ).toEqual([]);
  });

  it("does not exempt nested or shadowed webview requests inside plugin calls", () => {
    const source = `
      import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
      tauriFetch("https://allowed.example", { body: fetch("https://nested.example") });
      function shadow(tauriFetch: typeof fetch) { tauriFetch("https://shadow.example"); }
    `;
    expect(sourceHosts(source).map(({ host }) => host)).toEqual([
      "allowed.example",
      "nested.example",
      "shadow.example",
    ]);
  });

  it("blocks frames when the app has no iframe embeds", () => {
    expect(frameSources).toEqual(["'none'"]);
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
      {
        scheme: "wss",
        host: "api.gladia.io",
        why: "Gladia live SDK websocket (opened inside @gladiaio/sdk)",
      },
    ];
    for (const { scheme, host, why } of dynamicEndpoints) {
      expect(
        isAllowed(scheme, host, connectSources),
        `${scheme}://${host} — ${why}`,
      ).toBe(true);
    }
  });

  it("keeps host exemptions honest (no stale entries)", () => {
    // Every exempted host must still be referenced where its reason claims:
    // NON_CONNECT_HOSTS in the scanned (non-test) sources, and
    // KNOWN_NON_SOURCE_REFS in tauri.conf.json. A stale entry would silently
    // mask a future genuine fetch to that host.
    const corpus = scannedFiles()
      .map((abs) => readFileSync(abs, "utf8"))
      .join("\n");
    const stale = [...NON_CONNECT_HOSTS.keys()].filter(
      (host) => !corpus.includes(host),
    );
    expect(
      stale,
      `NON_CONNECT_HOSTS entries no longer referenced in the scanned sources — remove them (or move them to KNOWN_NON_SOURCE_REFS):\n  ${stale.join("\n  ")}`,
    ).toEqual([]);

    const staleNonSource = [...KNOWN_NON_SOURCE_REFS.keys()].filter(
      (host) => !tauriConfRaw.includes(host),
    );
    expect(
      staleNonSource,
      `KNOWN_NON_SOURCE_REFS entries no longer referenced in tauri.conf.json — remove them:\n  ${staleNonSource.join("\n  ")}`,
    ).toEqual([]);
  });
});
