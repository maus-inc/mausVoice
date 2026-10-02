import {
  AUTHORIZATION_SCHEMES as UTIL_AUTHORIZATION_SCHEMES,
  schemeValueEnd,
} from "@maus-inc/utilities";

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

const isQuote = (character: string | undefined): boolean =>
  character === '"' || character === "'";

/**
 * One end of the run of a quoted value's characters, or null when the closing
 * quote never arrives. The offset is the index OF the closing quote, so it is
 * the end of the secret rather than of the document: the quote belongs to the
 * text around the value and stays readable, which is what keeps
 * `{"api_key":"...","model":"..."}` parseable after redaction.
 *
 * `API_KEY_VALUE_CHARACTERS` is the unquoted token's character set and has no
 * way to say "a quote opened a string", so a value holding a space or a comma
 * stopped at it and the rest of the key went on to the log line and the
 * persisted error metadata in the clear. This is the same rule the shared
 * `parameterEnd` applies to a quoted `name=value` inside an authorization
 * scheme; it is mirrored here rather than imported because that one reads its
 * offsets inside the text handed to `schemeValueEnd` and is not parameterised
 * for a whole message.
 *
 * A backslash escapes the next character, so a `\"` inside a JSON string is one
 * character of the value and not the quote that ends it. A quote that never
 * closes returns null and the caller falls back to the unquoted run: an
 * unterminated quote is not evidence that a value was ever quoted, and the
 * equivalence sweep in the test pins that fallback on the shapes the pattern
 * this scanner replaced matched.
 */
const quotedValueEnd = (
  message: string,
  index: number,
  quote: string,
): number | null => {
  for (let cursor = index; cursor < message.length; cursor += 1) {
    if (message[cursor] === "\\" && cursor + 1 < message.length) {
      cursor += 1;
      continue;
    }
    if (message[cursor] === quote) return cursor;
  }
  return null;
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
 * It now reads two shapes the pattern did not: a value whose first token is an
 * authorization scheme runs to the end of the value rather than to the next
 * space, so the credential after the scheme is redacted with it; and a quoted
 * value runs to its closing quote, because the character class has no way to
 * say a quote opened a string and stopped at the first space or comma inside
 * one. The equivalence sweep in the test proves the two agree on every shape
 * the pattern matched.
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
  const quote = message[cursor];
  if (isQuote(quote)) cursor += 1;
  cursor = whitespaceEnd(message, cursor);
  const firstTokenEnd = valueEnd(message, cursor);
  // The value class needs at least one character, so a label with nothing
  // after its separator is not an assignment. Checked before the quoted run is
  // consulted so an empty quoted value (`api_key=""`) stays a non-assignment.
  if (firstTokenEnd === cursor) return null;
  const schemeEnd = AUTHORIZATION_SCHEMES.has(
    message.slice(cursor, firstTokenEnd).toLowerCase(),
  )
    ? firstTokenEnd + schemeValueEnd(message.slice(firstTokenEnd))
    : firstTokenEnd;
  // A quoted value can hold characters the class does not, so it runs to its
  // closing quote. The scheme run already stops at one -- `schemeValueEnd`
  // treats a quote as the document resuming -- so this only widens the run for
  // the bare-token case.
  const closingQuoteEnd = isQuote(quote)
    ? quotedValueEnd(message, cursor, quote)
    : null;
  const end =
    closingQuoteEnd === null ? schemeEnd : Math.max(schemeEnd, closingQuoteEnd);
  return end > cursor ? end : null;
};

const AUTHORIZATION_LABELS = ["proxy-authorization", "authorization"];

/**
 * Redact the value of every `authorization` label, scheme and credential both.
 *
 * This was a pattern that matched the value as one token, which is right for
 * `authorization: gsk_abc` and wrong for every scheme that puts the credential
 * somewhere else: `Digest username="u", realm="r", response="s"` lost the scheme
 * word and kept the whole challenge, including the `response` the server
 * computed. It is a scanner now because the run's end is chosen by the text --
 * a scheme extends it past its parameters, a bare token does not -- which no
 * single pattern expresses.
 *
 * The separator may be quoted. A header echo or a request body arrives as JSON,
 * where a closing quote sits between the label and the `:` and another one opens
 * the value; requiring a bare `:` skipped the whole field, so the challenge went
 * into the log line and the persisted error metadata in the clear. Both quotes
 * are the document's, so they are consumed as syntax and the redaction keeps
 * their surroundings -- `{"authorization": "..."}` becomes
 * `{"[redacted]"}` -- rather than leaving a quote dangling in front of it.
 */
const redactAuthorizationLabels = (message: string): string => {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < message.length) {
    const label = AUTHORIZATION_LABELS.find((candidate) =>
      matchesAt(message, index, candidate),
    );
    if (
      label === undefined ||
      // A label inside a longer word is not a label: `unauthorization` and the
      // middle of `my_authorization_header` must survive untouched.
      /[A-Za-z0-9_-]/.test(message[index - 1] ?? "")
    ) {
      index += 1;
      continue;
    }
    let cursor = whitespaceEnd(message, index + label.length);
    // The JSON key form, where the label's own closing quote precedes the
    // separator.
    if (isQuote(message[cursor])) cursor += 1;
    cursor = whitespaceEnd(message, cursor);
    if (message[cursor] !== ":") {
      index += 1;
      continue;
    }
    cursor = whitespaceEnd(message, cursor + 1);
    const quote = message[cursor];
    if (isQuote(quote)) cursor += 1;
    cursor = whitespaceEnd(message, cursor);
    const valueStart = cursor;
    const firstTokenEnd = valueEnd(message, cursor);
    if (firstTokenEnd === valueStart) {
      index += 1;
      continue;
    }
    const scheme = message.slice(valueStart, firstTokenEnd).toLowerCase();
    let end = firstTokenEnd;
    if (AUTHORIZATION_SCHEMES.has(scheme)) {
      end = firstTokenEnd + schemeValueEnd(message.slice(firstTokenEnd));
    } else if (isQuote(quote)) {
      // A bare token has no parameters for `schemeValueEnd` to disambiguate the
      // quotes with, so a quoted one runs to its closing quote here for the same
      // reason the `api_key` scanner does it. The scheme branch is left alone: it
      // already ends at a quote, and a `Digest` challenge carries quotes of its
      // own (`nonce="u"`), which only the parameter walk can step over.
      const closingQuoteEnd = quotedValueEnd(message, cursor, quote);
      if (closingQuoteEnd !== null) end = Math.max(end, closingQuoteEnd);
    }
    // The label goes with the value, as it does for `api_key`: what identifies
    // the credential is the label that named it.
    parts.push(message.slice(copied, index), REDACTED);
    copied = end;
    index = end;
  }
  if (parts.length === 0) return message;
  parts.push(message.slice(copied));
  return parts.join("");
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
  redactAuthorizationLabels(
    redactApiKeyAssignments(
      PROVIDER_SECRET_PATTERNS.reduce(
        (cleaned, pattern) => cleaned.replace(pattern, REDACTED),
        message,
      ),
    ),
  );
