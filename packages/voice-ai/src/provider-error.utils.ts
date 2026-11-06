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
 * Where the credential after a value's first token ends.
 *
 * A scheme is the header's syntax rather than the credential, so its parameters
 * belong to the redaction, and a bare token has no parameters for
 * `schemeValueEnd` to disambiguate quotes with, so a quoted one runs to its
 * closing quote as well. Both runs are taken and the LONGER wins, which is the
 * whole point: a quoted scheme value can hold characters the scheme walk stops
 * at, and taking only the scheme run left the remainder of the credential in
 * clear. `authorization: "token abc def"` redacted to `[redacted] def"` while the
 * same value after an `api_key` label redacted whole, because the scheme branch
 * returned before the quote was ever read.
 *
 * This is deliberately the same order `apiKeyAssignmentEnd` applies, and the two
 * must stay in step: they read the same `AUTHORIZATION_SCHEMES` and the same
 * `schemeValueEnd`, and a value redaction that is correct after one label and
 * leaks after the other is not a distinction any caller can act on. The `Digest`
 * challenge is unaffected because its quote sits after the scheme's first token
 * rather than before it, so `quote` is not the value's here and the scheme run
 * stands on its own.
 */
const credentialEnd = (
  message: string,
  valueStart: number,
  firstTokenEnd: number,
  quote: string,
): number => {
  const scheme = message.slice(valueStart, firstTokenEnd).toLowerCase();
  const schemeEnd = AUTHORIZATION_SCHEMES.has(scheme)
    ? firstTokenEnd + schemeValueEnd(message.slice(firstTokenEnd))
    : firstTokenEnd;
  if (!isQuote(quote)) return schemeEnd;
  const closingQuoteEnd = quotedValueEnd(message, valueStart, quote);
  return closingQuoteEnd === null
    ? schemeEnd
    : Math.max(schemeEnd, closingQuoteEnd);
};

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
 * Where an authorization value starts and ends, and whether the label was a quoted key.
 *
 * `quotedKey` is what separates the two cases. A label written `"authorization":` is a JSON
 * key, so the text before the value is document STRUCTURE and has to survive; a label written
 * `authorization:` in free text is part of the thing being removed.
 */
type LabelValueSpan = {
  valueStart: number;
  valueEnd: number;
  quotedKey: boolean;
};

/**
 * The end of the value a label starting at `index` names, or null when there is
 * no assignment here at all. `valueStart` is where the value begins, so a caller can choose
 * to keep the label; see `LabelValueSpan`.
 *
 * Split out of the scan below because every step of it is a question about the
 * text and none of them changes what the scan should do next: a reader of the
 * loop wants to see the label, the redaction and the step forward, and the walk
 * from a label to a value is the same walk whichever label it was.
 */

const labelValueEnd = (
  message: string,
  index: number,
  label: string,
): LabelValueSpan | null => {
  let cursor = whitespaceEnd(message, index + label.length);
  // The JSON key form, where the label's own closing quote precedes the
  // separator.
  const quotedKey = isQuote(message[cursor]);
  if (quotedKey) cursor += 1;
  cursor = whitespaceEnd(message, cursor);
  // `=` as well as `:`, matching `apiKeyAssignmentEnd` above and the shared
  // scrubber, so an `authorization=<credential>` echo is redacted too.
  if (message[cursor] !== ":" && message[cursor] !== "=") return null;
  cursor = whitespaceEnd(message, cursor + 1);
  const quote = message[cursor];
  if (isQuote(quote)) cursor += 1;
  cursor = whitespaceEnd(message, cursor);
  const valueStart = cursor;
  const firstTokenEnd = valueEnd(message, cursor);
  // The value class needs at least one character, so a label with nothing after
  // its separator is not an assignment.
  if (firstTokenEnd === valueStart) return null;
  return {
    valueStart,
    valueEnd: credentialEnd(message, cursor, firstTokenEnd, quote),
    quotedKey,
  };
};

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
    // A label inside a longer word is not a label: `unauthorization` and the
    // middle of `my_authorization_header` must survive untouched.
    //
    // A SEPARATOR is the exception, because `-` and `_` each do double duty: they join
    // the words inside a longer identifier AND they prefix a header name. Refusing both
    // meant `x-authorization` and `x_authorization` were never recognised as labels at
    // all, so the Digest challenge behind either reached the log and the persisted
    // error metadata in the clear. Measured before this change: both came back
    // byte-for-byte unchanged, while the same value after a bare `authorization:` was
    // redacted.
    //
    // The separator vocabulary is not a local choice. The shared scrubber in
    // `utilities/src/error.ts` already redacted `x_authorization`, `my_authorization` and
    // `no_authorization` -- its qualifier, `SEPARATOR_CLASS = "[ _-]"`, admits `-` and
    // `_` -- so this scanner was the weaker of the two on the same string, and
    // `redactProviderMessage` never calls the shared scrubber, so there was no backstop.
    //
    // They now agree on each of the seven shapes the tests cover: the three underscore
    // spellings, the two hyphenated ones, and the two that must survive. The agreement is
    // a property of THIS scanner's label list plus the shared qualifier, so a seventh
    // spelling outside that list would still be this scanner's answer alone.
    //
    // The two labels that still survive are kept by DIFFERENT mechanisms, which is worth
    // knowing before anyone reads one test as covering both. Measured by neutralising
    // only this guard (`inside = false`) and re-running each shape:
    //
    //   unauthorization:            untouched here, REDACTED with the guard off
    //   my_authorization_header:    untouched here, untouched with the guard off
    //
    // So the guard is load-bearing for `unauthorization` -- the character before the
    // label is `n` -- and inert for `my_authorization_header`, where the character is
    // `_`, which this line now admits. That one survives on `labelValueEnd` instead: the
    // label is followed by `_header`, so there is no `:` or `=` and no assignment to
    // redact. Both redactors agree on both, and the control test below pins each.
    const previous = message[index - 1] ?? "";
    const inside =
      /[A-Za-z0-9_-]/.test(previous) && previous !== "-" && previous !== "_";
    const span =
      label === undefined || inside
        ? null
        : labelValueEnd(message, index, label);
    if (span === null) {
      index += 1;
      continue;
    }
    // Two cases, and the difference is whether the label was a quoted JSON key.
    //
    // Free text, `authorization: Bearer <credential>`: the label goes WITH the value, because
    // what names the credential is the label that named it. That is deliberate and pinned --
    // the fixtures above split at the label boundary so the secret scanner never sees a
    // contiguous credential-shaped token, and keeping the label would put one back.
    //
    // A quoted key, `{"authorization":"Bearer <credential>"}`: the label is document
    // STRUCTURE, so erasing it leaves the key's own opening quote with nothing to close,
    // and the body stops parsing:
    //
    //   {"authorization":"Bearer <credential>"}  ->  {"[redacted]"}       did not parse
    //   {"api_key":"Digest nonce=..."}          ->  {"[redacted]"}       did not parse either
    //
    // `span.valueEnd` stops at the value's own closing quote, so consuming the label as well
    // is what orphaned the quote. Starting the replacement at the value instead keeps the
    // document intact.
    //
    // `api_key` has the same defect and this change does NOT fix it. `{"api_key":"sk-..."}`
    // looks like a counter-example -- the key survives there -- and it is not:
    // `PROVIDER_SECRET_PATTERNS` matches the `sk-` prefix first and replaces the value,
    // after which the api_key scanner finds nothing left to act on. On a value matching no
    // secret prefix the same shape gives `{"[redacted]"}`, unparseable.
    //
    // Applying the same fix to the sibling turns several of this file's OWN expectations red:
    // two hard-coded literals, and the comparisons against `REFERENCE_SECRET_PATTERNS` in the
    // test file, whose `api[_-]?key["']?\s*[:=]\s*["']?\s*...` pattern captures the label
    // along with the value. So the label erasure is what the test file expects of BOTH
    // scanners, and changing one without the other is the thing to avoid. That FIXTURE is what
    // blocks the sibling change, not the shared scrubber.
    //
    // The shared scrubber in `packages/utilities/src/error.ts` does not arbitrate here either,
    // and not in our favour: matching an `api_key` label, it KEEPS the label and redacts only
    // the value. Measured over 221760 shapes -- 12 label spellings x 10 separator forms x 4
    // key-quote forms x 3 value-quote forms x 14 values x 11 wrappings, none of which injects
    // another credential name -- it erased the label in ZERO.
    //
    // The qualifier matters. A SEPARATE sweep of 40320 shapes -- the same 12 label spellings x
    // 10 separator forms x 4 key-quote forms x 3 value-quote forms x 14 values, wrapped in 2
    // enclosing forms instead of 11 -- erases the api_key label in 40110 of them, because the
    // outer label consumes the span and
    // the inner one goes with it. That is the outer match winning, not this name being
    // dropped, so it is not a counter-example to the sentence above.
    //
    // Read from that file's own `CREDENTIAL_NAMES` rather than from a list typed out here, all
    // NINETEEN of them keep the label on every shape they match: api_key, authorization,
    // access_token, refresh_token, id_token, secret_token, client_secret, private_key,
    // session_token, session_key, secret_key, subscription_key, apim_key, password, passwd, pwd,
    // credential, secret and bearer. "Every shape they MATCH" is the operative phrase and
    // the qualifier is not cosmetic: over 108 shapes per name the scrubber redacted the value
    // and kept the label in 72, and left the other 36 untouched. Every one of those 36 is a
    // SINGLE-QUOTED KEY -- `'api_key': 'abc'` comes back verbatim.
    //
    // Untouched is not the same as unseen, and the difference is what the sentence above rests
    // on. A single-quoted key defeats the LABEL passes, but not the value passes:
    // `'api_key': 'sk-abcdefgh'` becomes `'api_key': '[redacted]'`, because
    // `PROVIDER_KEY_PREFIX` (error.ts:10) is quote-blind. So the label survives there because
    // the passes that ran did not touch it, not because the scrubber never looked at it.
    // `PROVIDER_KEY_PREFIX` is also what redacts `'token': 'sk-abcdefgh'`, which is why the bare
    // `token` below is a statement about the LABEL passes and not about the whole file.
    //
    // Bare `token` is the case that made me write this down wrongly the first time, and it is
    // NOT one of the nineteen: `token: abc` is untouched too, so it "kept the label" on every
    // shape and matched nothing on any of them. A name that is never matched cannot testify
    // about what happens when it is, which is why it does not belong in a list of keepers.
    //
    // `bearer` is the one name whose survival depends on what FOLLOWS it, because
    // `BEARER_TOKEN` is `/\bBearer\s+\S+/gi` and that pattern can match the label itself:
    // `bearer : abc` loses the word, `bearer: abc` keeps it, because `:` defeats the `\s+`.
    // That is the scheme pattern eating a word, not a label being dropped.
    //
    // So on a quoted key the two scanners disagree in every shape measured. That makes the
    // sibling a two-implementation decision plus a fixture change, not a one-line follow-up.
    parts.push(
      message.slice(copied, span.quotedKey ? span.valueStart : index),
      REDACTED,
    );
    copied = span.valueEnd;
    index = span.valueEnd;
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
