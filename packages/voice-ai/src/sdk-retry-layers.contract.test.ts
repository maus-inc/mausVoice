import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * No SDK client in this package may retry behind the shared helper's back.
 *
 * Every provider entry point wraps its client in `retry({ retries: 3 })`, and each SDK
 * defaults to `maxRetries: 2`. With both layers live the attempts multiply: measured, one
 * failed `openaiGenerateTextResponse` issued 9 requests for a 500 and 9 for a 429, while a
 * 400 and a 401 issued 1. Every one of those is a chargeable request.
 *
 * This is a structural assertion and it has to be. "Which clients are constructed, and with
 * what options" has no runtime expression to assert against -- the constructors are called
 * inside `createClient` helpers that return before anything observable happens. The
 * alternative is a behavioural test that counts requests per provider, which needs a live
 * endpoint or a stub for each SDK in turn, and would go stale the moment a provider is added
 * rather than the moment one is misconfigured.
 *
 * The sweep is deliberately constructor-agnostic. An earlier version of this listed
 * `new OpenAI(`, `new Anthropic(` and `new Groq(` and skipped any file not containing one of
 * them, which silently skipped `azure-openai.utils.ts` -- a site that carries the same
 * `retry()` call and the same comment. So it matches `new <Anything>({` whose options object
 * contains a `fetch:` key, which is what makes a client ours.
 */
const SRC = join(import.meta.dirname);

const sourceFiles = readdirSync(SRC).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

type Site = { file: string; line: number; ctor: string };

const clientSites = (): Site[] => {
  const sites: Site[] = [];
  for (const file of sourceFiles) {
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const ctor = /^\s*(?:return |const \w+ = )?new (\w+)\(\{/.exec(
        lines[i] ?? "",
      );
      if (!ctor) continue;
      const window: string[] = [];
      for (let j = i; j < Math.min(i + 30, lines.length); j += 1) {
        window.push(lines[j] ?? "");
        if (/^\s*\}\);\s*$/.test(lines[j] ?? "")) break;
      }
      // A `fetch:` in the options object is what makes the constructor an HTTP client that
      // we own, and therefore one whose retry behaviour is this package's decision.
      if (!window.some((w) => w.includes("fetch:"))) continue;
      sites.push({ file, line: i + 1, ctor: ctor[1] ?? "?" });
    }
  }
  return sites;
};

describe("SDK clients do not retry behind the shared helper", () => {
  const sites = clientSites();

  it("finds the clients at all", () => {
    // A sweep that matches nothing passes everything below it, so its subject is pinned
    // first. Eight as of this writing; the assertion is `>= 2` so adding a provider does not
    // mean editing this file, but a sweep broken by a refactor is caught here.
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it("sets maxRetries: 0 on every one", () => {
    const offenders = sites.filter((site) => {
      const lines = readFileSync(join(SRC, site.file), "utf8").split("\n");
      const window: string[] = [];
      for (
        let j = site.line - 1;
        j < Math.min(site.line + 29, lines.length);
        j += 1
      ) {
        window.push(lines[j] ?? "");
        if (/^\s*\}\);\s*$/.test(lines[j] ?? "")) break;
      }
      return !window.some((w) => w.includes("maxRetries: 0,"));
    });
    expect(
      offenders.map((s) => `${s.file}:${s.line} (${s.ctor})`),
      "each of these leaves the SDK's own retry layer enabled underneath retry()",
    ).toEqual([]);
  });
});
