import { describe, expect, it } from "vitest";
import {
  hasAuthoritativeId,
  rewriteDefaultMessages,
  shouldTransform,
} from "./formatjs-ids";

/**
 * The old patterns, kept verbatim so the unrolled replacements can be compared
 * against them. They are the reference implementation: `S8786` objected to their
 * backtracking behaviour, not to their meaning.
 */
const REFERENCE_INLINE = /\{\s*defaultMessage:\s*("(?:[^"\\]|\\.)*")/g;
const REFERENCE_BROKEN = /\{\s*\n(\s*)defaultMessage:\s*("(?:[^"\\]|\\.)*")/g;
const REFERENCE_PROP =
  /(<FormattedMessage\s+)defaultMessage=("(?:[^"\\]|\\.)*")/g;
const REFERENCE_BROKEN_PROP =
  /(<FormattedMessage\s*\n\s*)defaultMessage=("(?:[^"\\]|\\.)*")/g;
/**
 * The old id guard, kept to prove the simplification only widened it: every
 * module the reference accepted, the current form accepts too.
 */
const REFERENCE_ID_GUARD = /id:\s*"[0-9a-f]{6}",\s*\n?\s*defaultMessage/;

function referenceRewrite(
  code: string,
  idFor: (literal: string) => string,
): string {
  let out = code.replace(
    REFERENCE_INLINE,
    (_m, literal: string) =>
      `{ id: "${idFor(literal)}", defaultMessage: ${literal}`,
  );
  out = out.replace(
    REFERENCE_BROKEN,
    (_m, indent: string, literal: string) =>
      `{\n${indent}id: "${idFor(literal)}",\n${indent}defaultMessage: ${literal}`,
  );
  out = out.replace(
    REFERENCE_PROP,
    (_m, prefix: string, literal: string) =>
      `${prefix}id="${idFor(literal)}" defaultMessage=${literal}`,
  );
  out = out.replace(
    REFERENCE_BROKEN_PROP,
    (_m, prefix: string, literal: string) =>
      `${prefix}id="${idFor(literal)}" defaultMessage=${literal}`,
  );
  return out;
}

/**
 * Stands in for `createMessageId`, which returns six hex characters. The exact
 * value does not matter, but the *shape* does: `hasAuthoritativeId` only
 * recognises a six-hex id, so a placeholder like `id-19` would make the
 * idempotence test pass for the wrong reason.
 */
const idFor = (literal: string) => {
  let hash = 0;
  for (const ch of literal) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash.toString(16).padStart(6, "0").slice(-6);
};

/**
 * Inputs that exercise every branch of the string-literal pattern: plain text,
 * embedded escapes, an escaped backslash, an escaped quote adjacent to the
 * closing quote, an empty string, an unterminated string, and a concatenation
 * the plugin must leave alone because the descriptor is not a bare literal.
 */
const CASES = [
  `const a = intl.formatMessage({ defaultMessage: "Hello there" });`,
  `const a = intl.formatMessage({ defaultMessage: "Say \\"hi\\" now" });`,
  `const a = intl.formatMessage({ defaultMessage: "back\\\\slash" });`,
  `const a = intl.formatMessage({ defaultMessage: "ends with \\\\" });`,
  `const a = intl.formatMessage({ defaultMessage: "" });`,
  `const a = intl.formatMessage({ defaultMessage: "unterminated });`,
  `const a = intl.formatMessage({ defaultMessage: "part one " + name });`,
  `const a = intl.formatMessage({\n  defaultMessage: "Broken over a line",\n  description: "x",\n});`,
  `<FormattedMessage defaultMessage="Prop form" />`,
  `<FormattedMessage\n  defaultMessage="Broken prop"\n/>`,
  `// no descriptor here at all`,
];

describe("rewriteDefaultMessages", () => {
  it.each(CASES)("matches the reference transform on %j", (code) => {
    expect(rewriteDefaultMessages(code, idFor)).toBe(
      referenceRewrite(code, idFor),
    );
  });

  it("rewrites each of the four shapes to a descriptor that can render", () => {
    for (const code of CASES) {
      const out = rewriteDefaultMessages(code, idFor);
      if (!code.includes("defaultMessage")) continue;
      if (code.includes('" + ')) {
        // A concatenation still has a leading literal, and the babel plugin
        // hashes that literal rather than the result, so the id is injected
        // after the first string and `+ name` is left in place.
        expect(out).toMatch(/id[:=]\s*"?[0-9a-f]{6}"?/);
        expect(out).toContain("+ name");
        continue;
      }
      if (out === code) {
        // The only other unchanged case is the unterminated literal. The
        // concatenation above was already skipped, so it cannot reach here.
        expect(code).toContain("unterminated");
        continue;
      }
      expect(out).toMatch(/id[:=]\s*"?[0-9a-f]{6}"?/);
    }
  });

  it("does not inject an id twice", () => {
    const once = rewriteDefaultMessages(CASES[0], idFor);
    expect(hasAuthoritativeId(once)).toBe(true);
    expect(rewriteDefaultMessages(once, idFor)).toBe(once);
  });
});

describe("hasAuthoritativeId", () => {
  it.each([
    [`id: "abc123",\ndefaultMessage`, true],
    [`id:   "abc123",\n     defaultMessage`, true],
    [`id: "abc123", defaultMessage`, true],
    // Now accepted: whitespace before the comma used to be rejected.
    [`id:  "abc123"  ,  defaultMessage`, true],
    [`id: "abc12", defaultMessage`, false],
    [`id: "ABC123", defaultMessage`, false],
    // Widened by the simplification: whitespace before the comma was rejected
    // by the old three-quantifier form. Both are already-rewritten descriptors.
    [`id: "abc123"  ,defaultMessage`, true],
    [`id: "abc123"`, false],
    [`defaultMessage: "x"`, false],
  ])("%j -> %s", (code, expected) => {
    expect(hasAuthoritativeId(code)).toBe(expected);
  });
});

describe("hasAuthoritativeId versus the reference guard", () => {
  it.each([
    `id: "abc123",\ndefaultMessage`,
    `id: "abc123", defaultMessage`,
    `id:"abc123",defaultMessage`,
    `id: "abc12", defaultMessage`,
    `id: "ABCDEF", defaultMessage`,
    `defaultMessage: "x"`,
    `nothing here`,
  ])("accepts everything the reference accepted, for %j", (code) => {
    if (REFERENCE_ID_GUARD.test(code)) {
      expect(hasAuthoritativeId(code)).toBe(true);
    }
  });
});

describe("shouldTransform", () => {
  it("takes the desktop and preview sources", () => {
    expect(shouldTransform("/repo/apps/desktop/src/foo.tsx")).toBe(true);
    expect(shouldTransform("/repo/apps/preview/src/demo.tsx")).toBe(true);
  });

  it("leaves the harness entry and everything else alone", () => {
    expect(
      shouldTransform("/repo/apps/preview/verify-harness/mic-dialog.tsx"),
    ).toBe(false);
    expect(shouldTransform("/repo/apps/desktop/src-tauri/build.rs")).toBe(
      false,
    );
    expect(shouldTransform("/repo/node_modules/x/src/y.tsx")).toBe(false);
  });
});

/**
 * A backtracking pattern goes quadratic on a long run of characters that almost
 * match. These inputs are large but the linear patterns handle them instantly;
 * the test exists so that reintroducing the nested quantifier shows up as a
 * timeout rather than as a slow build nobody traces.
 */
describe("pathological inputs", () => {
  it("handles a long unterminated quoted run without backtracking", () => {
    const code = `{ defaultMessage: "${"a".repeat(200_000)}`;
    const started = performance.now();
    rewriteDefaultMessages(code, idFor);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("handles a long run of escapes without backtracking", () => {
    const code = `{ defaultMessage: "${'\\"'.repeat(100_000)}`;
    const started = performance.now();
    rewriteDefaultMessages(code, idFor);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
