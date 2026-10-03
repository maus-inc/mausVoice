const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_REDACT_DEPTH = 8;
const REDACTED = "[redacted]";

const BEARER_TOKEN = /\bBearer\s+\S+/gi;
// `csk-` in addition to `csk_`: Cerebras issues the hyphenated form too, and
// the `sk-` alternative cannot stand in for it because there is no word
// boundary between the leading `c` and the `s`.
const PROVIDER_KEY_PREFIX =
  /\b(?:csk[_-]|gsk[_-]|sk-ant-|xai-|sk-)[0-9a-z_-]{8,}/gi;
// A label naming a secret.
//
// ONE vocabulary, read by both redaction paths. There used to be two: the
// pattern below, and a separate alias set plus a substring test behind
// `isSecretKey` for object keys. They disagreed, and every disagreement was a
// defect in one direction or the other:
//
//   `openai_api_key` was redacted in a message and printed in the clear in a
//   provider's JSON body. `isSecretKey` normalised the key to `openaiapikey` and
//   looked for `api_key` inside it, which is not there. The JSON path was
//   strictly WORSE than the text path on the shape that matters most, because a
//   provider error body is a JSON object.
//
//   `secretary` was masked in a JSON body and left readable in a message,
//   because `isSecretKey` searched for `secret` anywhere in a string. The same
//   test masked `keyboard`, `hotkey` and `whiskey` used as object keys.
//
// So both paths now run the same rule. The names below are the only place a
// credential label is written down: `isCredentialLabel` applies this pattern
// anchored to a whole label to judge an object key, and the three labelled-value
// patterns further down embed the same pattern unanchored to find the same
// labels in free text. A label cannot redact in one form and leak in the other,
// because there is only one list for it to be missing from.
//
// Each name is a word sequence joined with an OPTIONAL separator, so `api_key`,
// `api-key` and `apikey` are one entry. There is deliberately no `["apikey"]`
// entry -- `api[_-]?key` already accepts that spelling, and an entry that changes
// nothing is one the next reader has to check.
//
// Two tiers, because one list cannot do both jobs. The first is a spelling that
// names a credential unambiguously -- `api_key`, `client_secret`, `password`,
// `secret`, `subscription_key` -- and ANY separator-delimited qualifier may sit
// in front of it. The second is the ambiguous words `token` and `key`, which
// need a qualifier drawn from the holder list.
//
// The measurements behind that split are worth keeping, because each one was
// wrong before it was right:
//
//   An arbitrary qualifier over BOTH tiers redacts ordinary fields. Any
//   `(?:[a-z0-9]+[_-])*` in front reaches `sort_key`, `partition_key`,
//   `cache_key`, `idempotency_key`, `max_tokens` and `total_tokens` -- ordinary
//   fields in a provider error for an app whose whole job is calling models.
//   Restricting it to the secret vocabulary fixed that and dropped ten
//   credential labels the other way, so an enumeration is the trade being made:
//   unbounded recall for precision, not a way of having both.
//
//   `azure_api_key` is the case that set the tier boundary. `api[_-]?key`
//   cannot match inside `azure_api_key` -- `_` is a word character, so there is
//   no boundary -- and `PROVIDER_KEY_PREFIX` recognises only `csk_`, `gsk_`,
//   `sk-ant-`, `xai-` and `sk-`, so an Azure subscription key and a Deepgram key
//   carry none of those. Measured, `azure_api_key`, `groq_api_key`,
//   `deepgram_api_key`, `elevenlabs_api_key` and `xai_api_key` all reached
//   `unknownToMessage` in the clear. `PROVIDER_KEY_PREFIX` is not the backstop
//   for a qualified label, because only four providers have a prefix at all.
//   So an unambiguous spelling takes any qualifier: there is no realistic field
//   called `sort_api_key`, which is what makes the unbounded prefix safe here and
//   only here.
//
//   A bare `key` is in neither tier. `\bkey\b` matches the English word wherever
//   it appears, so `press the key: any` came out as `press the key:[redacted]`.
//   Removing `key` outright then un-redacted `secret_key: <credential>` -- the
//   case the prefix exists for -- and the test pinning `secret_key` is what
//   caught that. `secret[_-]?key` is therefore spelled out as a tier-1
//   alternative, and a lone `key: <value>` is not recognised at all.
//
//   The missing leading segments are handled by the holder list. `aws` and
//   `azure` were not in it, and `aws_secret_access_key` and
//   `azure_subscription_key` both leaked in a message AND in a JSON body, while
//   `my_aws_secret_access_key` redacted -- because `my` was listed. Tier 2 is
//   anchored at `\b` against a fixed holder list precisely so that an arbitrary
//   qualifier cannot be mistaken for a credential, so the leading segment has to
//   be named. Adding tier-1 names `access_key` and `subscription_key` covers both
//   labels too, and that was tried first; it also matches
//   `Ocp-Apim-Subscription-Key`, which then read as a free-form label and took
//   the two lines after it with it. See `KEY_HOLDERS` for why the holder list
//   was the better place.
//
// No camelCase QUALIFIER either: any pattern accepting one lets `monkey` donate
// its `key` by backtracking, so `monkey: bananas` becomes `monkey:[redacted]`.
//
// A camelCase label with no qualifier does match, which is worth being precise
// about because it reads as a contradiction. The tier-1 names are two words with
// an OPTIONAL separator and the match is case-insensitive, so `apiKey`,
// `secretKey`, `clientSecret`, `privateKey`, `accessToken` and `refreshToken`
// all match as themselves. What cannot cross is a qualifier: in text,
// `openaiApiKey`, `signingKey` and `userPassword` are not labels, because there
// is no separator for the qualifier to be recognised by. Measured, that is 7 of
// 15 qualified camelCase labels unredacted in a message and 0 of 15 as an object
// key -- see `foldCamelLabel`, which is why the two forms differ here.
//
// What anchoring the rule gives up is a credential word in the MIDDLE of a
// longer key, which the old substring test used to catch: `db_password_hint`,
// `secret_rotation_enabled` and `client_secret_value` now survive. All three are
// metadata ABOUT a credential rather than one, so that is the side the loss falls
// on, and a test pins it so it stays a decision instead of a hole. Measured over
// a corpus of 56 credential names and 55 ordinary provider fields, this rule
// gains 18 labels the object path missed (`openai_api_key`, `oauth_token`,
// `signing_key`, `encryption_key`, `x-api-key` among them), loses those 8
// middle-word names, fixes the `secretary` and `keyboard` over-redaction, and
// introduces NO new over-redaction anywhere in the ordinary corpus.
//
// `bearer` is a tier-1 name AND a tier-2 holder, which looks like a duplicate
// and is not: as a name it recognises `{ "bearer": <token> }`, and as a holder it
// recognises `bearer_token`. The old alias set had only the bare spelling, so the
// name is here to keep that.
const CREDENTIAL_NAMES: readonly (readonly string[])[] = [
  ["api", "key"],
  ["authorization"],
  ["access", "token"],
  ["refresh", "token"],
  ["id", "token"],
  ["secret", "token"],
  ["client", "secret"],
  ["private", "key"],
  ["session", "token"],
  ["session", "key"],
  ["secret", "key"],
  ["password"],
  ["passwd"],
  ["pwd"],
  ["credential"],
  ["secret"],
  ["bearer"],
];

/**
 * The roles whose `token` or `key` holds a credential.
 *
 * `aws` and `azure` are here, and they read as vendor names in a list of roles
 * like `vault`, `keyring`, `account` and `service`. That is the point: those are
 * all the same kind of thing -- the system that ISSUES and holds the key -- and
 * an Azure subscription key is held by Azure rather than by a `service`, so
 * adding the two clouds puts them where the list's own definition puts them.
 *
 * They were added here rather than as tier-1 names `access_key` and
 * `subscription_key`, which also cover `aws_secret_access_key` and
 * `azure_subscription_key`, and the reason is measured rather than preferred. A
 * tier-1 `subscription_key` also matches `Ocp-Apim-Subscription-Key`, the Azure
 * API Management header, which is a real header carrying a real key -- and that
 * label then became a free-form one, so the free-form pass read past the end of
 * its value and swallowed the next two lines of a provider error, including the
 * `Reason:` the user is meant to read. Two entries here fix the two labels that
 * actually leaked and leave every other label's classification untouched.
 */
const KEY_HOLDERS: readonly string[] = [
  "aws",
  "azure",
  "oauth",
  "auth",
  "bearer",
  "signing",
  "master",
  "encryption",
  "private",
  "client",
  "session",
  "access",
  "refresh",
  "id",
  "api",
  "user",
  "db",
  "account",
  "service",
  "provider",
  "vault",
  "keyring",
  "updater",
  "licence",
  "license",
  "secret",
  "my",
];

const OPTIONAL_SEPARATOR = "[_-]?";
// The shape, written out, because the grouping here is load-bearing and a
// misplaced bracket silently NARROWS the rule instead of failing to compile:
//
//   (?: <tier 1> | <tier 2> )(?: plural | numbered )?
//
// The suffix group belongs OUTSIDE the alternation. Left inside it, it applies
// to tier 2 only, and `credentials` and `secrets` quietly stop being labels
// while `signing_key` keeps working -- which presents as a flaky rule rather
// than as a misplaced bracket.
const CREDENTIAL_LABEL_CORE =
  "(?:" +
  // Tier 1: an unambiguous name, behind any separator-delimited qualifier.
  `(?:[a-z0-9]+[_-])*(?:${CREDENTIAL_NAMES.map((name) => name.join(OPTIONAL_SEPARATOR)).join("|")})` +
  // Tier 2: the ambiguous words, behind a qualifier from the holder list.
  `|(?:${KEY_HOLDERS.join("|")})[_-](?:[a-z0-9]+[_-])*(?:token|key)` +
  ")" +
  // A plural or a numbered variant is the same label.
  String.raw`(?:s|[_-]?\d+)?`;
// The same core twice, and that is the point: unanchored, to find a label
// somewhere in free text with the document's own quotes and word boundaries
// around it, and anchored, to judge a bare object key that has no surrounding
// document. They are built from one source, so they cannot drift.
const SECRET_LABEL = String.raw`("?\b${CREDENTIAL_LABEL_CORE}\b"?)`;

/**
 * The one credential-label test, and both redaction paths call it.
 *
 * Anchored, because the alternative is searching for a credential word anywhere
 * in the key, and that masks `secretary`, `keyboard`, `hotkey` and `whiskey` as
 * object keys. An object key is a whole label, so the whole-label rule is the
 * right one; the unanchored form above exists only to LOCATE a label inside a
 * larger message, where `\b` and the following `[:=]` are what keep
 * `monkey: bananas` readable.
 *
 * Quotes and whitespace are trimmed first, so a label that arrived from the
 * quoted form of the pattern -- `SECRET_LABEL` captures the surrounding quotes
 * so a replacement can put them back -- is judged on the label itself.
 */
const ANCHORED_CREDENTIAL_LABEL = new RegExp(`^${CREDENTIAL_LABEL_CORE}$`, "i");
/**
 * Strips the quotes and whitespace a label may arrive wrapped in.
 *
 * The trailing edge is walked rather than matched, and that is a measured
 * decision. As one pattern -- `/^["'\s]+|["'\s]+$/g` -- it is quadratic: the `g`
 * loop retries the second alternative at every offset of a run, and each attempt
 * runs `["'\s]+` greedily to the end of the run before walking back one character
 * at a time looking for `$`. On a 400 000-character run that is 77 seconds.
 *
 * Splitting it into two single-anchored patterns does NOT help, and that was the
 * first thing tried: `["'\s]+$` backtracks identically, measured at 3.92x per
 * doubling against the original's 4.00x. Only removing the regex from the
 * trailing edge removes the backtracking, so that is what this does.
 *
 * The leading edge keeps its pattern because `^["'\s]+` succeeds on the first
 * try and never has to try again. Behaviour is unchanged -- identical on 21
 * hand-picked shapes and on 200 000 random strings.
 */
const LEADING_LABEL_EDGE = /^["'\s]+/;
const LABEL_EDGE_CHAR = /["'\s]/;

const trimLabelEdges = (label: string): string => {
  const body = label.replace(LEADING_LABEL_EDGE, "");
  let end = body.length;
  while (end > 0 && LABEL_EDGE_CHAR.test(body.charAt(end - 1))) {
    end -= 1;
  }
  return body.slice(0, end);
};

/**
 * `openaiApiKey` -> `openai_api_key`, so the anchored rule above can judge it.
 *
 * An object key is a whole identifier, so unlike a label inside a message there
 * is nothing around it for a suffix to backtrack into. That makes a camelCase
 * qualifier safe HERE and unsafe in `SECRET_LABEL`, which scans free text -- any
 * pattern that accepts a bare camel prefix there lets `monkey` donate its `key`
 * and turns `monkey: bananas` into `monkey:[redacted]`. So the difference
 * between the two forms is deliberate and it lives in this function rather than
 * in a second copy of the vocabulary.
 *
 * Folding to separators and then running the SAME anchored regex is what keeps
 * this from becoming a second rule to keep in step. Measured on the labels it
 * did not catch before: `authToken`, `signingKey`, `encryptionKey`,
 * `userPassword`, `dbPassword`, `openaiApiKey`, `azureApiKey` now redact, and
 * `secretary`, `keyboard`, `hotkey`, `whiskey`, `tokenize`, `sortKey` and
 * `maxTokens` still do not, because folding turns the last two into `sort_key`
 * and `max_tokens`, which the holder rule rejects for the same reason the
 * snake_case ones are rejected.
 *
 * WHAT THE TEXT FORM STILL DOES NOT CATCH, and why it is left that way: a
 * QUALIFIED camelCase label. `openaiApiKey`, `azureApiKey`, `authToken`,
 * `signingKey` and `userPassword` all reach `unknownToMessage` in the clear in a
 * message, while none leak as an object key. Those five are examples from the
 * same measured set as the "7 of 15" above -- not a second, smaller measurement
 * -- and a wider probe found every qualified camelCase name it tried leaking,
 * 8 of 8. An unqualified camelCase name -- `apiKey`, `secretKey`, `clientSecret`
 * -- matches on both forms.
 *
 * The obvious way to close it is to let the text form's tier-1 qualifier take a
 * separator-less prefix, i.e. `(?:[a-z0-9]+[_-]*)*`. Measured: that does not fail
 * a test, it HANGS the suite. The separator is what bounds each iteration, and
 * making it optional turns the qualifier into a nested quantifier that
 * backtracks catastrophically on ordinary input. So the gap is not held open by
 * an oversight and `monkey` is not the only reason -- removing the separator is
 * worse than the leak, and the pinned test
 * `leaves the text half of that gap exactly as it is today` is what will catch
 * anyone trying it and finding out the slow way.
 */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const foldCamelLabel = (label: string): string =>
  label.replace(CAMEL_BOUNDARY, "$1_$2");

const isCredentialLabel = (label: string): boolean => {
  const trimmed = trimLabelEdges(label);
  return (
    ANCHORED_CREDENTIAL_LABEL.test(trimmed) ||
    ANCHORED_CREDENTIAL_LABEL.test(foldCamelLabel(trimmed))
  );
};
// The one tier-1 name that denotes a header rather than a stored credential, so
// it is matched as the END of a label: `authorization` and `proxy-authorization`
// are the two spellings, and `AUTHORIZATION_SCHEME` handles both.
const AUTHORIZATION_LABEL_END = /authorization$/i;
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
// The free-form counterpart of `LABELED_SECRET_BARE`. Same label and same
// scheme-word step-over; the value is a run to the next separator rather than
// one token, which is the whole difference. The leading character class is what
// keeps this off a QUOTED value -- a value opening with a quote is left to
// `LABELED_SECRET_QUOTED`, which reads it to the closing quote, and this pass's
// own run would stop at the quote and redact only the part before it.
//
// It has to be a pattern with a long value class rather than a scanner reading
// past the end of a match it was given: `String.replace` replaces exactly the
// matched span, so re-reading further into the string from inside the callback
// redacts the value but leaves its tail in the clear exactly where the old
// one-token value left it.
//
// What ends a value here is the next field separator, or the end of the message.
// A free-form value has no closing quote to read to -- that is what
// distinguishes it from a quoted one, which `quotedValueEnd` handles -- so the
// separators the surrounding text supplies are the only boundaries there are.
// Whitespace does not end it, and that includes a newline, for two reasons that
// are both about the same credential: a PEM private key is multi-line by
// construction, so a rule that stopped at the first newline could not redact one
// at all; and `redactUnknown` already redacts an entire multi-line string sitting
// under a secret key, so a newline-bounded rule in text would leak the very
// secret the structured path removes.
//
// The cost is real and is taken deliberately: prose on the same line after a
// passphrase is indistinguishable from the rest of the passphrase, so it goes
// too. That is why a separator and not the line end is the stop -- `password:
// wrong, try again` keeps its diagnosis -- and why `describesField` still runs
// first, so `password: missing` stays prose.
const FREE_FORM_SECRET_BARE = new RegExp(
  String.raw`${SECRET_LABEL}\s*([:=])\s*(?:(?:${AUTHORIZATION_SCHEME_WORDS})\s+)?([^"';\s][^,;]*)`,
  "gi",
);
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

/**
 * Whether this value names the missing field rather than being one.
 *
 * Deliberately an exact match against a short list. A tempting extension is to
 * treat a run containing any diagnostic word -- "could", "not", "required" -- as
 * prose, so that `credential: could not decrypt` keeps its first word instead of
 * losing it to the redaction. That was written, measured, and reverted: it
 * defers `password: no idea but hunter2`, `password: can you open it` and
 * `password: not my password` in full. Prose markers occur inside real
 * passphrases, so the heuristic trades a lost word in a diagnostic for a
 * credential printed in a log, and that is the wrong trade in a scrubber.
 *
 * The cost that remains is one word. `credential: could not decrypt` becomes
 * `credential:[redacted] not decrypt`, which is ugly and readable. That is the
 * right side of the trade to be on.
 */
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
 * One end of a quoted run starting at `index`, or `index` when no quote opens
 * there. A backslash escapes the next character, so `\"` does not close it.
 * An unterminated run has no end to report, so it returns `index` and the
 * caller falls back to its own reading of the text.
 */
const quotedValueEnd = (text: string, index: number): number => {
  const quote = text[index];
  if (quote !== '"' && quote !== "'") return index;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\" && cursor + 1 < text.length) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
  }
  return index;
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
    const quoted = quotedValueEnd(text, cursor);
    return quoted === cursor ? text.length : quoted;
  }
  return tokenEnd(text, cursor);
};

export const schemeValueEnd = (text: string): number => {
  let end = 0;
  // Whether any non-whitespace token has been read yet. A quote opens the
  // credential only before the first one; after it, a quote is a parameter's.
  let readAnyToken = false;
  while (end < text.length) {
    if (SCHEME_WHITESPACE.test(text[end])) {
      end += 1;
      continue;
    }
    // A quoted run where the credential itself starts is the credential whole.
    // Without this the value ended at the opening quote, the scan resumed
    // inside the string, and `authorization: Basic "abc def"` redacted only
    // `Basic` -- leaving `def` in the clear, because the tail of a quoted
    // secret has no `=` for the parameter reader below to recognise.
    //
    // Only the FIRST token is read this way. Past it the text is a parameter
    // list, and a quote there belongs to a parameter value: read as a
    // credential of its own it ran `Digest nonce="x", "model": "llama-3"` on to
    // swallow the `"model"` field as well, so the redaction ate the document's
    // own JSON syntax.
    if (!readAnyToken) {
      const quoted = quotedValueEnd(text, end);
      if (quoted !== end) {
        return quoted;
      }
    }
    const parameter = parameterEnd(text, end);
    if (parameter !== end) {
      end = parameter;
      readAnyToken = true;
      continue;
    }
    // A closer that ends the document is not part of any credential.
    if (isCloser(text[end])) return end;
    end = tokenEnd(text, end);
    readAnyToken = true;
    // A bare token is the credential only when no parameter follows it;
    // otherwise it is a parameter name and the list continues.
    if (parameterEnd(text, end) === end) return end;
  }
  return end;
};

/**
 * The secret aliases whose value is a single token, so the one token after the
 * label is the whole credential.
 *
 * An API key is one word by construction and an OAuth bearer is one word by
 * construction, so stopping at the space for those leaks nothing. A passphrase
 * and a PEM key are not: `password: correct horse battery staple` and a
 * multi-line `private_key` have spaces in them, and reading only the first word
 * put the rest of the credential in the clear directly beside a marker saying it
 * had been redacted. Those are the ones `isFreeFormSecretLabel` excludes from
 * this set.
 *
 * Stated as the complement rather than as a list of the free-form names, because
 * this set is what says "one token" and the rest of the vocabulary says
 * "credential at all". A new credential name added to `CREDENTIAL_NAMES` lands on
 * the free-form side of this line by construction, which is the safe side: an
 * over-wide read of a credential that cannot contain a space costs a diagnosis,
 * and an under-wide read prints the tail of a passphrase in the clear.
 *
 * The membership is separator-free (`accesstoken`, not `access_token`) because
 * `isFreeFormSecretLabel` looks the label up by that form, and the question here
 * is which credential it is rather than whether it is one.
 *
 * Every name here is also a name `SECRET_LABEL` matches. That is not a
 * coincidence to be re-established by hand: `isFreeFormSecretLabel` consults
 * `isCredentialLabel`, which runs the same pattern `SECRET_LABEL` embeds, so a
 * name this set holds is a name the string path recognises, and a name the
 * string path recognises is a name that reaches this predicate at all. The old
 * arrangement could not say that -- `isSecretKey` accepted names the pattern
 * never matched, and `secret_key` was the case that caught it.
 */
const TOKEN_SHAPED_SECRET_ALIASES: ReadonlySet<string> = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "authorization",
  "bearer",
  // `secret` and `credential` are NOT here, and that is deliberate even though
  // they name no token. Reading only one token after them leaked the tail of a
  // passphrase under a label that says, in as many words, that it holds a
  // secret -- and leaving them out of the wider read made the protection
  // backwards: `client_secret`, `session_key` and `password` redacted a
  // passphrase whole while `secret` and `credential` did not, so the least
  // specific label got the least protection.
  //
  // The cost is a destroyed diagnosis. A `credential` label followed by "could
  // not decrypt" becomes a bare marker, and `unknownToMessage` output is what a
  // user attaches to a diagnostics export. That is accepted: in a scrubber a
  // leaked credential is a security failure and a lost word is an annoyance,
  // and no stop available distinguishes the two -- a short diagnosis has no
  // double space, so the "stop at two spaces" idea fixes the passphrase and
  // re-breaks the diagnosis in one move.
]);

/**
 * Labels whose value is read as a whole run rather than as one token.
 *
 * The credential head decides it, and the head is read from the label WITH its
 * separators. Normalising first erases the `_` that makes `signing` a holder of
 * a `key`, so `signing_key` stops being recognisable and the free-form pass
 * leaves it to the one-token pass below -- still redacted, but only the first
 * word of anything longer. `TOKEN_SHAPED_SECRET_ALIASES` is keyed on the
 * separator-free form because that is the question being asked of it ("is this
 * credential one token?"), while `isCredentialLabel` needs the separators
 * ("is this a credential at all?").
 */
const isFreeFormSecretLabel = (label: string): boolean => {
  const bare = trimLabelEdges(label);
  const joined = bare.replace(/[_-]/g, "").toLowerCase();
  // `authorization` and `proxy-authorization` are the one label the free-form
  // pass must not claim, because `AUTHORIZATION_SCHEME` owns them and reads the
  // scheme word as syntax rather than as part of the credential. A free-form run
  // starts at the value, so it swallowed the scheme word too and turned
  // `proxy-authorization: Digest abc` into `proxy-authorization:[redacted]`.
  //
  // It has to be a test on the label rather than an entry in
  // `TOKEN_SHAPED_SECRET_ALIASES`, which is keyed on the separator-free form
  // and so cannot distinguish `authorization` from `proxy-authorization`. This
  // used to fall out of `isSecretKey` by accident: normalising
  // `proxy-authorization` to `proxyauthorization` left no credential word in it,
  // so the free-form pass skipped it. That was never the reason it worked.
  if (AUTHORIZATION_LABEL_END.test(bare)) return false;
  return isCredentialLabel(bare) && !TOKEN_SHAPED_SECRET_ALIASES.has(joined);
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
    // First, and only for the labels whose value is free-form. `LABELED_SECRET_BARE`
    // captures one token, which is the whole of a token-shaped credential but
    // only the first word of a passphrase or a key blob; this pass re-reads the
    // run from where that token ended and takes it to the separator.
    //
    // It runs before every pass that writes the marker, and that ordering is the
    // point rather than an accident. A pass that ran after them would have to
    // recognise the marker to tell an already-redacted value from a credential
    // that begins with the marker's own characters, and any such test has a
    // hole: `password: [redacted] hunter2` is either a finished redaction or a
    // passphrase starting with a bracket. Reading the value first means the
    // marker is never there to be confused, so both cases redact.
    .replace(
      FREE_FORM_SECRET_BARE,
      (match, label: string, sep: string, rawValue: string) => {
        // Every other label, including both authorization headers, is left
        // entirely to the passes below, which is the whole of how this pattern
        // differs from `LABELED_SECRET_BARE`: same label, same scheme-word
        // step-over, same guards -- a run for the value instead of one token.
        if (!isFreeFormSecretLabel(label)) return match;
        const [value, tail] = splitTrailingClosers(rawValue);
        if (describesField(value)) return match;
        return `${label}${sep}${REDACTED}${tail}`;
      },
    )
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
        if (describesField(value)) return match;
        // An earlier pass may have already replaced this value with the marker,
        // as AUTHORIZATION_SCHEME does for a scheme credential. Matching the
        // marker as though it were the value destroyed the scheme word and left
        // the credential's tail sitting in the clear right beside it --
        // `authorization: Bearer abc def` became
        // `authorization:[redacted] def`, which reads as redacted and is not.
        // The marker is not a value, so there is nothing here to redact.
        if (value === REDACTED) return match;
        return `${label}${sep}${REDACTED}${tail}`;
      },
    );

const capLength = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;

/**
 * A value that renders itself through `toJSON` is rendered through that method
 * by `JSON.stringify`, so walking its own properties would replace the rendered
 * form -- and the rendered form is the one that gets printed. Such a value is
 * resolved instead and its rendered form redacted, so a secret reachable ONLY
 * through `toJSON` cannot escape the key rules.
 *
 * Walking the properties was not enough, and the reason is specific rather than
 * incidental: `redactUnknown` builds a plain object from `Object.entries`, and
 * `Object.entries` reports `toJSON` as an ordinary own property, so the copy
 * carried the method through with the original as its receiver. `JSON.stringify`
 * then called it and stringified the result with no redaction pass at all,
 * which leaked even a bare `api_key`.
 */
const hasJsonForm = (value: object): value is { toJSON(): unknown } =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

const redactJsonForm = (
  value: { toJSON(): unknown },
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  // Depth is charged for the resolution, so a `toJSON` that returns itself -- or
  // two objects whose `toJSON` methods hand each other back -- runs into the
  // same ceiling as any other deep structure instead of recursing.
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  try {
    return redactUnknown(value.toJSON(), depth + 1, seen);
  } catch {
    // A `toJSON` that throws cannot be rendered by `JSON.stringify` either, so
    // a marker is the honest outcome; the value behind it is never printed.
    return REDACTED;
  }
};

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
      out[key] = isCredentialLabel(key)
        ? REDACTED
        : redactUnknown(child, depth + 1, seen);
    }
    return out;
  };

  if (typeof value === "string") return redactSensitiveTokens(value);
  if (value === null || typeof value !== "object") return value;
  // Resolved at every depth, not only at the top: a nested `toJSON` leaked too,
  // under an ordinary key, and a top-level-only guard would have left that one.
  if (hasJsonForm(value)) return redactJsonForm(value, depth, seen);
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
