const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_REDACT_DEPTH = 8;
const REDACTED = "[redacted]";

const BEARER_TOKEN = /\bBearer\s+\S+/gi;
// `csk-` in addition to `csk_`: Cerebras issues the hyphenated form too, and
// the `sk-` alternative cannot stand in for it because there is no word
// boundary between the leading `c` and the `s`.
const PROVIDER_KEY_PREFIX =
  /\b(?:csk[_-]|gsk[_-]|sk-ant-|xai-|sk-)[0-9a-z_-]{8,}/gi;
const SECRET_LABEL = String.raw`"?\b(api[_-]?key|apiKey|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?token|session[_-]?key|password|passwd|pwd|credential|secret)\b"?`;
// Either quote style; basic-string backslash escapes only exist in double
// quotes, but accepting them in single-quoted values too is harmless because
// the whole value is replaced either way.
const QUOTED_SECRET_VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const LABELED_SECRET_QUOTED = new RegExp(
  String.raw`${SECRET_LABEL}\s*([:=])\s*${QUOTED_SECRET_VALUE}`,
  "gi",
);
// The scheme words, shared by the two labelled passes so the one that redacts
// and the one that judges a placeholder cannot drift apart, and exported because
// a provider scrubber has to judge the same words: it decides whether the token
// it read is a whole credential or only the syntax in front of one.
export const AUTHORIZATION_SCHEMES: ReadonlySet<string> = new Set([
  "bearer",
  "basic",
  "token",
  "digest",
  "negotiate",
  "apikey",
  "api-key",
]);
const AUTHORIZATION_SCHEME_WORDS = Array.from(AUTHORIZATION_SCHEMES).join("|");
// The bare value runs to the next whitespace/`,`/`;`. Closing brackets
// that belong to the surrounding text (`{api_key=abc}`) are split off
// afterwards by `splitTrailingClosers`, so a value that contains its own
// balanced pair (`api_key=some(value)`) is still redacted in full. An
// authorization scheme word is stepped over rather than read as the value, so
// `authorization: token missing` is judged on `missing`; the scheme word is the
// label's syntax, not a credential.
const LABELED_SECRET_BARE = new RegExp(
  String.raw`${SECRET_LABEL}\s*([:=])\s*(?:(?:${AUTHORIZATION_SCHEME_WORDS})\s+)?([^\s,;]+)`,
  "gi",
);
// A labelled scheme carries a second token after it, so matching the label
// alone redacted the word `Basic` and left the credential beside it in clear
// text (`Authorization: Basic <credential>` -> `Authorization:[redacted]
// <credential>`). Consume the scheme and its credential together, or drop both.
const AUTHORIZATION_SCHEME = new RegExp(
  String.raw`\b(authorization|proxy-authorization)\s*:\s*(?:(${AUTHORIZATION_SCHEME_WORDS})\s+)?([^\r\n]*)`,
  "gi",
);
const CLOSER_TO_OPENER: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};
const OPENER_TO_CLOSER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CLOSER_TO_OPENER).map(([closer, opener]) => [opener, closer]),
);
/**
 * Bare values that describe the field instead of carrying a credential
 * (`api_key=required`, `authorization: missing`). Left readable so validation
 * messages stay useful. Anything else after a secret label is redacted;
 * `true`/`false` are deliberately absent: a boolean never describes a
 * credential field usefully.
 */
const PLACEHOLDER_VALUES = new Set([
  "required",
  "missing",
  "invalid",
  "expired",
  "revoked",
  "null",
  "undefined",
  "none",
  "empty",
]);

const describesField = (value: string): boolean =>
  PLACEHOLDER_VALUES.has(value.toLowerCase());

/**
 * Where a scheme's credential ends inside `text`, which is the text following
 * the scheme word: the offset is relative to `text` and covers the credential.
 *
 * A scheme is the header's syntax, not the credential, so `Basic dXNlcjpwYXNz`
 * is one secret in two tokens and the run has to cross the space. It also has to
 * cross the parameters of `Digest username="u", realm="r", response="s"`, where
 * stopping at the first token redacted `username="u"` and handed the rest on to
 * the callers that log the message and persist it as error metadata.
 *
 * What ends a credential is the surrounding document, not the next space: a
 * closing quote, a record separator, or a bracket ends it, and so does a word
 * with no `=` after it -- which is what keeps `Digest abc is not authorized`
 * from swallowing the diagnosis the line exists to carry. Anything shaped like
 * `name=value` is a parameter, so it extends the run.
 */
const SCHEME_VALUE_CLOSERS = "\"',;)]}";
const SCHEME_VALUE_NAME_CHARACTERS = /[A-Za-z0-9_-]/;
const SCHEME_WHITESPACE = /\s/;

const isCloser = (character: string | undefined): boolean =>
  character !== undefined && SCHEME_VALUE_CLOSERS.includes(character);

const spaceEnd = (text: string, index: number): number => {
  let end = index;
  while (end < text.length && SCHEME_WHITESPACE.test(text[end])) end += 1;
  return end;
};

/** One end of the run of token characters at `index`, stopping at whitespace or a closer. */
const tokenEnd = (text: string, index: number): number => {
  let end = index;
  while (
    end < text.length &&
    !SCHEME_WHITESPACE.test(text[end]) &&
    !isCloser(text[end])
  ) {
    end += 1;
  }
  return end;
};

/**
 * One end of the `name=value` entry starting at `index`, or `index` when there is
 * none there. A leading comma and any whitespace belong to the entry, so a
 * parameter list is consumed one entry at a time.
 *
 * This is a scanner rather than a pattern for a reason this repo has already
 * paid for once: the value alternative `(?:"..."|'...'|[^\s,]*)` is ambiguous
 * against the rest of the line, so the engine retries it against every prefix of
 * a long value, and the two whitespace runs either side of the optional comma can
 * split a single run between them and multiply that further. Each character here
 * has exactly one reading.
 */
const parameterEnd = (text: string, index: number): number => {
  let cursor = spaceEnd(text, index);
  if (text[cursor] === ",") cursor = spaceEnd(text, cursor + 1);
  const nameStart = cursor;
  while (
    cursor < text.length &&
    SCHEME_VALUE_NAME_CHARACTERS.test(text[cursor])
  ) {
    cursor += 1;
  }
  if (cursor === nameStart || text[cursor] !== "=") return index;
  cursor += 1;
  const quote = text[cursor];
  if (quote === '"' || quote === "'") {
    for (cursor += 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\" && cursor + 1 < text.length) {
        cursor += 1;
        continue;
      }
      if (text[cursor] === quote) return cursor + 1;
    }
    return text.length;
  }
  return tokenEnd(text, cursor);
};

export const schemeValueEnd = (text: string): number => {
  let end = 0;
  while (end < text.length) {
    if (SCHEME_WHITESPACE.test(text[end])) {
      end += 1;
      continue;
    }
    const parameter = parameterEnd(text, end);
    if (parameter !== end) {
      end = parameter;
      continue;
    }
    // A closer that ends the document is not part of any credential.
    if (isCloser(text[end])) return end;
    end = tokenEnd(text, end);
    // A bare token is the credential only when no parameter follows it;
    // otherwise it is a parameter name and the list continues.
    if (parameterEnd(text, end) === end) return end;
  }
  return end;
};

const SECRET_KEY_ALIASES = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "privatekey",
  "sessiontoken",
  "sessionkey",
  "password",
  "passwd",
  "pwd",
  "credential",
  "secret",
  "bearer",
]);

const isSecretKey = (key: string): boolean => {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    SECRET_KEY_ALIASES.has(normalized) ||
    /password|passwd|pwd|secret|privatekey|sessiontoken|credential/i.test(
      normalized,
    )
  );
};

/**
 * Splits trailing closing brackets that have no matching opener inside the
 * value, so they are kept as surrounding punctuation instead of being
 * treated as part of the secret. Invariant: the returned head is the longest
 * prefix whose bracket balance is not negative for any closer type, and the
 * tail is only ever made of `)`, `]`, `}`. One backward pass, O(n).
 */
const splitTrailingClosers = (value: string): [string, string] => {
  const balance: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (const char of value) {
    if (char in CLOSER_TO_OPENER) balance[char] += 1;
    else if (char in OPENER_TO_CLOSER) balance[OPENER_TO_CLOSER[char]] -= 1;
  }
  let end = value.length;
  while (end > 0) {
    const closer = value[end - 1];
    if (!(closer in CLOSER_TO_OPENER) || balance[closer] <= 0) break;
    balance[closer] -= 1;
    end -= 1;
  }
  return [value.slice(0, end), value.slice(end)];
};

export const redactSensitiveTokens = (message: string): string =>
  message
    // Before the labelled passes: those match the `authorization` label and
    // would otherwise consume only the scheme word, leaving the credential
    // beside it. A bare value with no scheme is left to the placeholder
    // handling below, so `authorization: missing` still reads as prose.
    .replace(
      AUTHORIZATION_SCHEME,
      (match, header: string, scheme: string | undefined, value?: string) => {
        if (scheme === undefined) {
          // No scheme token, so this is a plain labelled value such as
          // `authorization: missing`; defer to the passes that understand
          // placeholder values.
          return match;
        }
        if (value === undefined) return match;
        const end = schemeValueEnd(value);
        const credential = value.slice(0, end);
        const tail = value.slice(end);
        if (describesField(credential)) {
          // `authorization: token missing` describes the field in front of the
          // scheme, so defer rather than redact a value the caller needs to
          // read. LABELED_SECRET_BARE steps over the scheme word to judge the
          // word behind it, so this text survives both passes.
          return match;
        }
        return `${header}: ${scheme} ${REDACTED}${tail}`;
      },
    )
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(PROVIDER_KEY_PREFIX, REDACTED)
    .replace(LABELED_SECRET_QUOTED, "$1$2[redacted]")
    .replace(
      LABELED_SECRET_BARE,
      (match, label: string, sep: string, rawValue: string) => {
        const [value, tail] = splitTrailingClosers(rawValue);
        return describesField(value)
          ? match
          : `${label}${sep}${REDACTED}${tail}`;
      },
    );

const capLength = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;

const redactUnknown = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  const walkCollection = (collection: object): unknown => {
    if (seen.has(collection)) return "[Circular]";
    seen.add(collection);
    if (Array.isArray(collection)) {
      return collection.map((item) => redactUnknown(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(collection)) {
      out[key] = isSecretKey(key)
        ? REDACTED
        : redactUnknown(child, depth + 1, seen);
    }
    return out;
  };

  if (typeof value === "string") return redactSensitiveTokens(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  return walkCollection(value);
};

const redactJsonIfPossible = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redactSensitiveTokens(message);
  }
  try {
    return JSON.stringify(redactUnknown(JSON.parse(trimmed), 0, new WeakSet()));
  } catch {
    return redactSensitiveTokens(message);
  }
};

const messageFromUnknown = (error: unknown): string => {
  if (typeof error === "string") return redactJsonIfPossible(error);
  if (error instanceof Error) return redactJsonIfPossible(error.message);
  try {
    return (
      JSON.stringify(redactUnknown(error, 0, new WeakSet())) ??
      redactSensitiveTokens(String(error))
    );
  } catch {
    return redactSensitiveTokens(String(error));
  }
};

/**
 * Coerce any thrown value to a readable message without producing
 * `[object Object]` for plain objects. Obvious tokens are redacted and
 * the result is capped so logs and tool-failure text cannot dump secrets
 * or huge payloads.
 */
export const unknownToMessage = (error: unknown): string =>
  capLength(messageFromUnknown(error));
