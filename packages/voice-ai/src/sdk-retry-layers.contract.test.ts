import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
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
 * them, which silently skipped `azure-openai.utils.ts`. The sweep inspects each constructor
 * whose literal options include a `fetch` property and known SDK imports, without trusting
 * comments or nearby code. Non-literal options for a known SDK fail closed.
 */
const SRC = join(import.meta.dirname);

type Site = { file: string; line: number; ctor: string; safe: boolean };

/** Static property names include quoted and computed string-literal keys. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/** The final effective maxRetries must be literal zero, not shadowed by a spread. */
function retryPolicy(options: ts.ObjectLiteralExpression) {
  let hasFetch = false;
  let safe = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      safe = false;
      continue;
    }
    const key = propertyName(property.name);
    if (key === null) safe = false;
    if (key === "fetch") hasFetch = true;
    if (key === "maxRetries") {
      safe =
        ts.isPropertyAssignment(property) &&
        ts.isNumericLiteral(property.initializer) &&
        Number(property.initializer.text) === 0;
    }
  }
  return { hasFetch, safe };
}

const SDK_EXPORTS: Record<string, readonly string[]> = {
  openai: ["OpenAI", "AzureOpenAI"],
  "@anthropic-ai/sdk": ["Anthropic"],
  "groq-sdk": ["Groq"],
  "groq-sdk/index": ["Groq"],
};

/** Collect local aliases for known SDK class exports. */
function addSdkBindings(
  clients: Set<string>,
  clause: ts.ImportClause,
  exports: readonly string[],
) {
  if (clause.name) clients.add(clause.name.text);
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    for (const name of exports) clients.add(`${bindings.name.text}.${name}`);
    return;
  }
  for (const item of bindings.elements) {
    if (
      !item.isTypeOnly &&
      exports.includes((item.propertyName ?? item.name).text)
    ) {
      clients.add(item.name.text);
    }
  }
}

/** Recognize imported SDKs even when a client omits its custom fetch. */
function knownSdkClients(source: ts.SourceFile): Set<string> {
  const clients = new Set<string>();
  for (const node of source.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue;
    const exports = SDK_EXPORTS[node.moduleSpecifier.text];
    const clause = node.importClause;
    if (exports && clause && !clause.isTypeOnly)
      addSdkBindings(clients, clause, exports);
  }
  return clients;
}

function objectOptions(
  value: ts.Expression | undefined,
): ts.ObjectLiteralExpression | null {
  while (
    value &&
    (ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isNonNullExpression(value))
  ) {
    value = value.expression;
  }
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

/** Inspect actual constructor option properties rather than nearby text or comments. */
function clientSitesFromSource(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  const known = knownSdkClients(source);
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const ctor = node.expression.getText(source);
      const options = objectOptions(node.arguments?.[0]);
      const policy = options ? retryPolicy(options) : null;
      if (policy?.hasFetch || known.has(ctor)) {
        sites.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          ctor,
          safe: policy?.safe ?? false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected source link: ${path}`);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    return entry.isFile() &&
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

const clientSites = () =>
  sourceFiles().flatMap((file) =>
    clientSitesFromSource(file, readFileSync(file, "utf8")),
  );

describe("SDK clients do not retry behind the shared helper", () => {
  const sites = clientSites();

  it("does not count comments, nested properties, or later spreads as retry policy", () => {
    const fixtures = [
      `new SDK({ fetch: myFetch, /* maxRetries: 0, */ })`,
      `new SDK({ fetch: myFetch, nested: { maxRetries: 0 }, })`,
      `new SDK({ fetch: myFetch, maxRetries: 0, ...overrides })`,
      `new SDK({ fetch: myFetch, maxRetries: 0, maxRetries: 2 })`,
    ];
    for (const source of fixtures) {
      expect(clientSitesFromSource("fixture.ts", source)).toMatchObject([
        { safe: false },
      ]);
    }
  });

  it("finds multiline constructors and validates the final retry option", () => {
    const source = `new SDK(\n{\n  fetch,\n  ...defaults,\n  maxRetries: 0\n}\n)`;
    expect(clientSitesFromSource("fixture.ts", source)).toMatchObject([
      { safe: true },
    ]);
  });

  it("does not trust unknown computed keys after the retry option", () => {
    expect(
      clientSitesFromSource(
        "fixture.ts",
        `new SDK({fetch, maxRetries: 0, [name]: 2})`,
      ),
    ).toMatchObject([{ safe: false }]);
    expect(
      clientSitesFromSource(
        "fixture.ts",
        `new SDK({fetch, [name]: 2, ["maxRetries"]: 0})`,
      ),
    ).toMatchObject([{ safe: true }]);
  });

  it("finds nested source files without scanning tests", () => {
    const root = mkdtempSync(join(tmpdir(), "retry-source-"));
    try {
      mkdirSync(join(root, "providers"));
      for (const name of [
        "provider.ts",
        "provider.test.ts",
        "provider.spec.tsx",
        "providers/second.ts",
      ]) {
        writeFileSync(join(root, name), "");
      }
      expect(
        sourceFiles(root)
          .map((file) => file.slice(root.length + 1))
          .sort(),
      ).toEqual(["provider.ts", join("providers", "second.ts")].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("also checks known SDK clients without a custom fetch", () => {
    const source = `
      import Client from "openai";
      import { AzureOpenAI as Azure } from "openai";
      import * as AnthropicSDK from "@anthropic-ai/sdk";
      new Client({ maxRetries: 0 });
      new Azure(options);
      new AnthropicSDK.Anthropic({});
    `;
    expect(clientSitesFromSource("fixture.ts", source)).toMatchObject([
      { ctor: "Client", safe: true },
      { ctor: "Azure", safe: false },
      { ctor: "AnthropicSDK.Anthropic", safe: false },
    ]);
  });

  it("finds the clients at all", () => {
    // A sweep that matches nothing passes everything below it, so its subject is pinned
    // first. Eight as of this writing; the assertion is `>= 2` so adding a provider does not
    // mean editing this file, but a sweep broken by a refactor is caught here.
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it("sets maxRetries: 0 on every one", () => {
    const offenders = sites.filter((site) => !site.safe);
    expect(
      offenders.map((s) => `${s.file}:${s.line} (${s.ctor})`),
      "each of these leaves the SDK's own retry layer enabled underneath retry()",
    ).toEqual([]);
  });
});
