/**
 * The `formatMessage({ defaultMessage })` id rewriter, kept out of
 * `vite.config.ts` so it can be tested directly.
 *
 * The desktop components call `intl.formatMessage` with a bare defaultMessage,
 * and react-intl throws without an id. The real app builds through babel, which
 * rewrites those descriptors; the preview builds through Vite, which does not.
 * So the id is derived here the way the babel plugin derives it, but only for
 * files the verification harness reaches. Without this the harness cannot
 * render the real dialog and would have to fork it, which would verify the fork.
 *
 * Every pattern below is written in unrolled form — a quoted string is
 * `"` + a run of non-quote characters, then any number of escaped-character +
 * run pairs. The equivalent `("[^"\\]|\\.)*"` is the same language but backtracks
 * on an unterminated string, which is quadratic in the length of the input and
 * is a denial-of-service vector for anything that feeds it untrusted source.
 * Every source file the plugin sees is an input, so the linear form is the one
 * to use. `formatjs-ids.test.ts` pins the equivalence.
 */

/** A JavaScript double-quoted string literal, including its escapes. */
const STRING_LITERAL = `"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"`;

/** Report whether a module already carries an id, which means a second transform already ran. */
export function hasAuthoritativeId(code: string): boolean {
  // The transform can run more than once for a module in dev, and a second pass
  // would inject a second id and throw.
  //
  // The old form was `id:\s*"..."\s*\n?\s*defaultMessage`. Three quantifiers
  // over the same character class, each one able to retry at every position the
  // previous one gave up, which is the backtracking `S8786` reports. They are
  // also three spellings of one language: `\s*\n?\s*` accepts exactly the
  // strings `\s*` accepts, because `\n` is already in `\s`. So this is the
  // same matcher with the redundancy removed. Whitespace is also allowed
  // between the id and its comma now, which the old form rejected; that case
  // can only ever be another already-rewritten descriptor, so accepting it
  // avoids a double injection rather than risking one.
  return /id:\s*"[0-9a-f]{6}"\s*,\s*defaultMessage/.test(code);
}

/**
 * Rewrites every `defaultMessage` descriptor that does not yet carry an id.
 *
 * Four shapes carry a descriptor: an inline object, an object broken after the
 * brace, a JSX prop, and a JSX prop broken over a line. All four occur in these
 * components, and a missed one throws at render time and takes the whole dialog
 * down rather than only that message.
 *
 * `idFor` receives the literal exactly as written in the source, quotes and
 * escapes included, because the babel plugin derives the id from the source
 * text and not from the decoded string.
 */
export function rewriteDefaultMessages(
  code: string,
  idFor: (literal: string) => string,
): string {
  const inlineObject = new RegExp(
    `\\{\\s*defaultMessage:\\s*(${STRING_LITERAL})`,
    "g",
  );
  const brokenObject = new RegExp(
    `\\{\\s*\\n(\\s*)defaultMessage:\\s*(${STRING_LITERAL})`,
    "g",
  );
  const inlineProp = new RegExp(
    `(<FormattedMessage\\s+)defaultMessage=(${STRING_LITERAL})`,
    "g",
  );
  const brokenProp = new RegExp(
    `(<FormattedMessage\\s*\\n\\s*)defaultMessage=(${STRING_LITERAL})`,
    "g",
  );

  let rewritten = code.replace(
    inlineObject,
    (_m, literal: string) =>
      `{ id: "${idFor(literal)}", defaultMessage: ${literal}`,
  );
  rewritten = rewritten.replace(
    brokenObject,
    (_m, indent: string, literal: string) =>
      `{\n${indent}id: "${idFor(literal)}",\n${indent}defaultMessage: ${literal}`,
  );
  rewritten = rewritten.replace(
    inlineProp,
    (_m, prefix: string, literal: string) =>
      `${prefix}id="${idFor(literal)}" defaultMessage=${literal}`,
  );
  rewritten = rewritten.replace(
    brokenProp,
    (_m, prefix: string, literal: string) =>
      `${prefix}id="${idFor(literal)}" defaultMessage=${literal}`,
  );
  return rewritten;
}

/**
 * Report whether a module id is one the plugin should look at at all.
 *
 * The harness entry itself is excluded: it is harness code, and it does not call
 * `formatMessage`.
 */
export function shouldTransform(id: string): boolean {
  if (id.includes("/verify-harness/")) return false;
  if (!/apps\/(desktop|preview)\/src\//.test(id)) return false;
  return true;
}
