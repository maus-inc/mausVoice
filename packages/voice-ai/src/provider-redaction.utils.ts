/**
 * Provider-agnostic scrubbing of credential material out of provider messages.
 *
 * Several providers are wire-compatible and echo the same shapes: a 401 that
 * says "Incorrect API key provided: <key>", a proxy that replays the
 * `Authorization` header it received, and an SDK message that quotes the
 * `api_key` it sent. Those patterns are the same everywhere, so they live here
 * once. Each provider passes only the key prefixes it issues, and a prefix
 * added to one provider no longer has to be remembered in a second file.
 *
 * Nothing here narrows, truncates or partially reveals a secret. A match is
 * replaced whole with `[redacted]`, so a message that echoes `csk_ab` cannot
 * leak any of `csk_ab` by way of a length or first-character hint.
 */

/**
 * Credential shapes every provider can echo. The leading `\b` on the key-prefix
 * patterns keeps ordinary hyphenated words such as `task-123` intact, which a
 * bare `sk-` alternative would otherwise match.
 *
 * `csk_` is here rather than in a per-provider list because the wire-
 * compatible providers share a deployment: one provider's error text can
 * arrive through another's SDK, and before this list was shared the Groq copy
 * already had to carry `csk_` to cover that.
 */
const SHARED_PROVIDER_SECRET_PATTERNS: readonly RegExp[] = [
  /\bcsk_[a-z0-9_-]+/gi,
  /\bsk-[a-z0-9_-]+/gi,
  /\bsk_[a-z0-9_-]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /authorization:\s*[^\s;,]+/gi,
  /api[_-]?key[:=]\s*[a-z0-9._~+/=-]+/gi,
];

export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Scrub credential material from a provider message.
 *
 * `extraPatterns` carries the key prefixes one provider issues beyond the
 * shared shapes. Provider-specific patterns run first so a specific prefix
 * wins over a broader pattern that also matches inside it.
 */
export const redactProviderSecret = (
  message: string,
  extraPatterns: readonly RegExp[] = [],
): string =>
  [...extraPatterns, ...SHARED_PROVIDER_SECRET_PATTERNS].reduce(
    (cleaned, pattern) => cleaned.replace(pattern, REDACTED_PLACEHOLDER),
    message,
  );
