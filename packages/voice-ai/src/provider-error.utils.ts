import { AUTHORIZATION_SCHEMES as UTIL_AUTHORIZATION_SCHEMES } from "@maus-inc/utilities";

/**
 * Shared classification for provider HTTP failures.
 *
 * Every OpenAI-compatible provider rejects a wrong key, a retired model, and a
 * malformed request with a 4xx. Retrying those spends quota and delay for a
 * result that cannot change, and the raw SDK error is a JSON blob naming a
 * model the user has no way to act on. Each provider keeps its own wording, but
 * the status and code readers and the secret scrubbing are written once here so
 * a new provider inherits the behavior instead of copying it.
 *
 * Which statuses are worth not retrying is deliberately not here. It is not a
 * property of HTTP: a status that is terminal for one model is model-scoped for
 * another, so a shared set silently becomes the policy every provider adopts and
 * each one then has to argue with it. Groq's own reasoning for its set, which
 * excludes both 403 and 404, is recorded at `ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES`
 * in `groq.utils.ts`, and the same reasoning does not hold for every provider.
 */

/** The provider error code for a request naming a model it does not serve. */
export const PROVIDER_MODEL_NOT_FOUND_CODE = "model_not_found";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The HTTP status a provider rejection carries, or undefined for a network
 * failure, an abort, or a provider that reported no status.
 */
export const readProviderStatus = (error: unknown): number | undefined => {
  const status = asRecord(error)?.status;
  return typeof status === "number" ? status : undefined;
};

/**
 * The provider's machine-readable error code, for example
 * `model_not_found`. The OpenAI-compatible SDKs put it on the parsed error
 * body, so read both that and a code set directly on the error.
 */
export const readProviderCode = (error: unknown): string | undefined => {
  const outer = asRecord(error);
  const direct = outer?.code;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = asRecord(outer?.error)?.code;
  return typeof nested === "string" ? nested : undefined;
};

const REDACTED = "[redacted]";

// The authorization scheme words, from the shared utilities scrubber. Judged here
// rather than spelled out again so the two scrubbers cannot disagree about which
// words are a header's syntax and which are a credential.
const AUTHORIZATION_SCHEMES: ReadonlySet<string> = UTIL_AUTHORIZATION_SCHEMES;

const PROVIDER_SECRET_PATTERNS: RegExp[] = [
  // Groq issues `gsk_`, Cerebras `csk_`, and the OpenAI-compatible providers
  // `sk-` or `sk_`. The leading \b keeps `task-123` from matching `sk-`.
  /\b(?:gsk|csk|sk)[-_][a-z0-9_-]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /authorization:\s*[^\s;,]+/gi,
];

const WHITESPACE = /\s/;

const isWhitespace = (character: string | undefined): boolean =>
  character !== undefined && WHITESPACE.exec(character) !== null;

// The value class of the `api_key` shape, lowercased. Held as one string
// rather than a pattern because the scanner below matches it a character at a
// time, and a per-character pattern would be the backtracking this replaced.
const API_KEY_VALUE_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789._~+/=-";

/** One end of the whitespace run at `index`. */
const whitespaceEnd = (message: string, index: number): number => {
  let end = index;
  while (isWhitespace(message[end])) end += 1;
  return end;
};

/** One end of the run of value characters at `index`. */
const valueEnd = (message: string, index: number): number => {
  let end = index;
  while (
    message[end] !== undefined &&
    API_KEY_VALUE_CHARACTERS.includes(message[end].toLowerCase())
  ) {
    end += 1;
  }
  return end;
};

/**
 * The characters that close a scheme-prefixed value: a record separator or a
 * closing bracket, whatever is inside them.
 */
const SCHEME_VALUE_STOPS = `,;)]}`;

/**
 * The end of a value that opened with an authorization scheme.
 *
 * A scheme is the header's syntax, not the credential: `Basic dXNlcjpwYXNz` is
 * one secret in two tokens, and a value class that stops at whitespace redacts
 * the scheme and leaves the credential in the string this module hands to the
 * callers that log it and persist it as error metadata. So once the first token
 * is a scheme, the run continues past its parameters — the nonce in a Digest
 * header, the reason in a token scheme — to the first record separator or
 * closing bracket. This is the same rule `azure.utils.ts` applies to an
 * `authorization` label.
 *
 * A quote only ends the run when it does not open a parameter: the quote in
 * `nonce="x"` has to be walked through to reach the credential, while the quote
 * that closes `api_key="Basic <credential>"` ends it. A value the provider
 * quotes *after* the scheme (`Basic "<credential>"`) is the one shape this does
 * not reach; every provider body this module exists for quotes the value at the
 * separator.
 *
 * Gated on the scheme being one this module knows rather than run to the end of
 * the line for every value: a bare `api_key=<token>` in a provider message is
 * routinely followed by the diagnosis the user needs, and redacting that costs
 * the reason the log line exists. The scheme list is shared with the utilities
 * scrubber so the two cannot disagree about which words are syntax.
 */
const schemeValueEnd = (message: string, from: number): number => {
  let end = whitespaceEnd(message, from);
  while (end < message.length && !SCHEME_VALUE_STOPS.includes(message[end])) {
    if (
      (message[end] === '"' || message[end] === "'") &&
      message[end - 1] !== "="
    ) {
      break;
    }
    end += 1;
  }
  return end;
};

const matchesAt = (message: string, index: number, literal: string): boolean =>
  message.slice(index, index + literal.length).toLowerCase() === literal;

/**
 * Where the `api_key` assignment starting at `index` ends, or null when there
 * is none. Only the value is secret and the whole match including the label is
 * replaced, so nothing is left to identify the key.
 *
 * The optional quote on either side of the separator is what makes a JSON body
 * work. Without it the label has to be followed straight by `:` or `=`, so
 * `{"api_key":"..."}` never reached this shape at all, and a key whose prefix
 * the patterns above do not know went into the log whole. The value's own quote
 * is optional for the same reason: `api_key = "..."` is as ordinary as the JSON
 * form.
 *
 * This is a scanner where the shape used to be a pattern, because of the two
 * whitespace runs it needs. A remote end chooses the text and no caller of this
 * module bounds its length, and a pattern whose two unbounded whitespace runs
 * can split one run of whitespace between them lets that end choose input the
 * engine retries every split of, which is quadratic. A quote is not whitespace
 * and a value character is not whitespace, so each run and each optional
 * character here has exactly one reading and a single pass decides the match the
 * pattern decided.
 *
 * It now reads one shape the pattern did not: a value whose first token is an
 * authorization scheme runs to the end of the value rather than to the next
 * space, so the credential after the scheme is redacted with it. The equivalence
 * sweep in the test proves the two agree on every shape the pattern matched.
 */
const apiKeyAssignmentEnd = (message: string, index: number): number | null => {
  if (!matchesAt(message, index, "api")) return null;
  let cursor = index + "api".length;
  if (message[cursor] === "-" || message[cursor] === "_") cursor += 1;
  if (!matchesAt(message, cursor, "key")) return null;
  cursor += "key".length;

  if (message[cursor] === '"' || message[cursor] === "'") cursor += 1;
  cursor = whitespaceEnd(message, cursor);
  if (message[cursor] !== ":" && message[cursor] !== "=") return null;
  cursor += 1;

  cursor = whitespaceEnd(message, cursor);
  if (message[cursor] === '"' || message[cursor] === "'") cursor += 1;
  cursor = whitespaceEnd(message, cursor);
  const firstTokenEnd = valueEnd(message, cursor);
  const end =
    firstTokenEnd > cursor &&
    AUTHORIZATION_SCHEMES.has(
      message.slice(cursor, firstTokenEnd).toLowerCase(),
    )
      ? schemeValueEnd(message, firstTokenEnd)
      : firstTokenEnd;
  // The value class needs at least one character, so a label with nothing
  // after its separator is not an assignment.
  return end > cursor ? end : null;
};

/**
 * Replace every `api_key`-shaped assignment in a message, left to right. Runs
 * after `PROVIDER_SECRET_PATTERNS`, which is the order the combined pattern
 * list applied them in.
 */
const redactApiKeyAssignments = (message: string): string => {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < message.length) {
    const end = apiKeyAssignmentEnd(message, index);
    if (end === null) {
      index += 1;
      continue;
    }
    parts.push(message.slice(copied, index), REDACTED);
    copied = end;
    index = end;
  }
  if (parts.length === 0) return message;
  parts.push(message.slice(copied));
  return parts.join("");
};

/**
 * Replace the literal API key and common authorization material anywhere in a
 * provider message. The OpenAI-compatible SDKs echo the supplied key in their
 * own error strings ("Incorrect API key provided: gsk_..."), and some proxies
 * echo the Authorization header. Never reveals the key value itself (no
 * length or first characters), so a message like "key gsk_ab" redacts the
 * whole token.
 */
export const redactProviderMessage = (message: string): string =>
  redactApiKeyAssignments(
    PROVIDER_SECRET_PATTERNS.reduce(
      (cleaned, pattern) => cleaned.replace(pattern, REDACTED),
      message,
    ),
  );
