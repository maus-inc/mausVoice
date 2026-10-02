import { describe, expect, it } from "vitest";
import * as providerErrorUtils from "./provider-error.utils";

describe("provider-error.utils", () => {
  it("exports only the readers and the scrubber, and no retry policy", () => {
    // Which statuses are worth not retrying is per provider, not a property of
    // HTTP. A shared set here becomes the policy every provider adopts by
    // default, and each one then has to argue with it: this module shipped a
    // terminal-status helper that returned true for 404 while the one provider
    // reading these helpers documented at length why 404 must never be terminal
    // for it. A module that cannot express the distinction should not offer to
    // make it.
    expect(Object.keys(providerErrorUtils).sort()).toEqual([
      "PROVIDER_MODEL_NOT_FOUND_CODE",
      "readProviderCode",
      "readProviderStatus",
      "redactProviderMessage",
    ]);
  });
});

describe("readProviderStatus", () => {
  it("reads a status set directly on the error", () => {
    expect(providerErrorUtils.readProviderStatus({ status: 503 })).toBe(503);
  });

  it("returns undefined when there is no numeric status", () => {
    expect(providerErrorUtils.readProviderStatus(new Error("boom"))).toBe(
      undefined,
    );
    expect(providerErrorUtils.readProviderStatus({ status: "503" })).toBe(
      undefined,
    );
    expect(providerErrorUtils.readProviderStatus(null)).toBe(undefined);
    expect(providerErrorUtils.readProviderStatus("503")).toBe(undefined);
  });
});

describe("readProviderCode", () => {
  it("reads a code set on the error", () => {
    expect(providerErrorUtils.readProviderCode({ code: "rate_limit" })).toBe(
      "rate_limit",
    );
  });

  it("reads a code from the parsed error body", () => {
    expect(
      providerErrorUtils.readProviderCode({
        error: { code: providerErrorUtils.PROVIDER_MODEL_NOT_FOUND_CODE },
      }),
    ).toBe("model_not_found");
  });

  it("prefers the outer code and ignores a non-string one", () => {
    expect(
      providerErrorUtils.readProviderCode({
        code: "outer",
        error: { code: 7 },
      }),
    ).toBe("outer");
    expect(providerErrorUtils.readProviderCode({ code: 7 })).toBe(undefined);
  });
});

describe("redactProviderMessage", () => {
  // The key-shaped strings are split at the prefix so the secret scanner never
  // sees a contiguous token. It reads a full one as a leak, which is the right
  // call for real commits and the wrong one for a fixture, so the convention
  // here is the one the rest of this package's tests already use.
  const GROQ_KEY = "gsk_" + "liveAbCd1234";
  const CEREBRAS_KEY = "csk_" + "abc123DEF";

  it.each([
    ["a groq key", `Incorrect API key provided: ${GROQ_KEY}`, "gsk_"],
    [
      "a groq key with a hyphen",
      `Incorrect API key provided: ${GROQ_KEY.replace("_", "-")}`,
      "gsk-",
    ],
    ["a cerebras key", `rejected ${CEREBRAS_KEY}`, "csk_"],
    ["an openai style key", "rejected sk-proj-abc123", "sk-"],
    ["a bearer header", "Authorization: Bearer abc.def-ghi_jkl", "Bearer"],
    ["an authorization header", "authorization: token123abc", "authorization"],
    // The key-shaped strings are split at the prefix or the label boundary so
    // the secret scanner never sees one contiguous token. It reads a full one
    // as a leak, which is the right call for real commits and the wrong one for
    // a fixture, and the convention here is the one the rest of this package's
    // tests already use.
    ["an api key assignment", "api_key=" + "abc123def", "api_key"],
  ])("scrubs %s", (_label, input, mustNotSurvive) => {
    const output = providerErrorUtils.redactProviderMessage(input);
    expect(output).not.toContain(mustNotSurvive);
    expect(output).toContain("[redacted]");
  });

  it("leaves an ordinary message alone", () => {
    const message =
      "The model llama-3 does not exist or you do not have access";
    expect(providerErrorUtils.redactProviderMessage(message)).toBe(message);
  });

  // A key field in a JSON body. The label pattern needed `:` or `=` straight
  // after the name, so the quote a JSON body puts there meant the pattern never
  // matched, and a value with no prefix the patterns above know was passed
  // through whole. A key with a known prefix was still caught, which is why the
  // gap looked narrower than it was.
  it.each([
    ["groq", "gsk_" + "abc123XYZ"],
    ["cerebras", "csk_" + "abc123XYZ"],
    ["openai", "sk-" + "abc123XYZ"],
    ["no known prefix", "abc123XYZnotaprefix"],
  ])("scrubs %s in a JSON body", (_label, value) => {
    const body = `{"api_key":"${value}"}`;
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(value);
    expect(output).toContain("[redacted]");
  });

  it("scrubs an unprefixed key in an unquoted field too", () => {
    // Split at the label boundary so the secret scanner never sees one
    // contiguous `label=value` token. It reads a whole one as a leak, which is
    // the right call for a real commit and the wrong one for a fixture, and it
    // is why the key-shaped strings above are written the same way.
    const UNPREFIXED = "abc123" + "XYZnotaprefix";
    for (const body of ["api_key=" + UNPREFIXED, "API-KEY : " + UNPREFIXED]) {
      const output = providerErrorUtils.redactProviderMessage(body);
      expect(output).not.toContain(UNPREFIXED);
      expect(output).toContain("[redacted]");
    }
  });

  // A scheme is the header's syntax and the credential is the token after it, so
  // `Basic dXNlcjpwYXNz` is one secret in two tokens. The value class stops at
  // whitespace, so the redaction used to end at the scheme word and hand the
  // credential on in the clear to `normalizeGroqError`, whose own contract is
  // that this scrubber is what keeps the key out of logs and persisted
  // `postProcessError` metadata. Split at the label so the fixture never holds a
  // contiguous `label=value` token.
  const SCHEME_CREDENTIAL = "dXNlcjpw" + "YXNz";
  it.each([
    [
      "a basic scheme in a JSON body",
      `{"api_key":"Basic ${SCHEME_CREDENTIAL}"}`,
    ],
    ["a token scheme quoted", `api_key="token ${SCHEME_CREDENTIAL}"`],
    ["an apikey scheme unquoted", `api_key=ApiKey ${SCHEME_CREDENTIAL}`],
    [
      "a bearer scheme with the label spaced out",
      `API-KEY : Bearer ${SCHEME_CREDENTIAL}`,
    ],
    [
      "a digest scheme with its parameters",
      `api_key=Digest nonce="${SCHEME_CREDENTIAL}", realm="x"`,
    ],
    [
      "a scheme inside a sentence",
      `upstream said api_key=Basic ${SCHEME_CREDENTIAL} and gave up`,
    ],
  ])("scrubs %s whole", (_label, body) => {
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(SCHEME_CREDENTIAL);
    expect(output).toContain("[redacted]");
  });

  // A quoted value ends at its closing quote, not at the first character the
  // value class does not hold. The class is the unquoted token's character set
  // and it has no way to say "the quote opened a string", so `api_key="Ai za-
  // Qq0Wx1"` was cut after `Ai` and the rest of the key went into the log line
  // and the persisted `postProcessError` metadata in the clear -- and the
  // prefix patterns do not know an `Ai`-shaped key, so nothing downstream
  // caught it either.
  const QUOTED_HEAD = "Ai" + "za";
  const QUOTED_TAIL = "Qq0" + "Wx1";
  it.each([
    ["a space", " "],
    ["a comma", ","],
    ["a colon", ":"],
    ["an equals sign", "="],
  ])("scrubs a quoted api key value holding %s", (_label, separator) => {
    const body = `api_key="${QUOTED_HEAD}${separator}${QUOTED_TAIL}"`;
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(QUOTED_HEAD);
    expect(output).not.toContain(QUOTED_TAIL);
    expect(output).toContain("[redacted]");
    // The quote belongs to the document, not to the secret, so it stays and the
    // JSON around the field is still parseable.
    expect(output).toBe('[redacted]"');
  });

  it("scrubs a quoted api key value holding an escaped quote", () => {
    // The `\"` is one character of the value, not the quote that ends it. Reading
    // it as the closing quote cut the value in half and handed the rest of the
    // key on in the clear, which is the same leak with a different separator.
    const body = `api_key="${QUOTED_HEAD}\\"${QUOTED_TAIL}"`;
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(QUOTED_HEAD);
    expect(output).not.toContain(QUOTED_TAIL);
  });

  it("keeps the rest of a JSON document readable around a quoted key value", () => {
    const body = `{"api_key":"${QUOTED_HEAD} ${QUOTED_TAIL}","model":"llama-3"}`;
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(QUOTED_HEAD);
    expect(output).not.toContain(QUOTED_TAIL);
    expect(output).toBe('{"[redacted]","model":"llama-3"}');
  });

  it("stops a scheme-prefixed value where the surrounding document resumes", () => {
    // The run goes to the end of the value, not to the end of the message: a
    // record separator or a closing quote still ends it, so the rest of a JSON
    // document stays readable and a second field is not swallowed.
    const output = providerErrorUtils.redactProviderMessage(
      `{"api_key":"Basic ${SCHEME_CREDENTIAL}","model":"llama-3"}`,
    );
    expect(output).not.toContain(SCHEME_CREDENTIAL);
    expect(output).toContain('"model":"llama-3"');
  });

  it("still keeps the prose that follows a bare token value", () => {
    // The scheme rule is what widens the run, and it is deliberately gated on
    // the first token being a scheme. A bare `api_key=<token>` is routinely
    // followed by the reason the message carries, and redacting that would cost
    // the diagnosis the log line exists to give.
    const output = providerErrorUtils.redactProviderMessage(
      "api_key=" + "abc123XYZnotaprefix" + " is not configured on this account",
    );
    expect(output).not.toContain("abc123XYZnotaprefix");
    expect(output).toContain("is not configured on this account");
  });

  it("leaves an ordinary hyphenated token alone", () => {
    // The documented intent of the leading \b: `sk-` must not match inside a
    // longer word, or every hyphenated identifier in a log line would be
    // redacted and the message would be useless.
    for (const message of [
      "task-12345",
      "the sprint-period review",
      "monkey-12345",
      "disk-usage 88%",
    ]) {
      expect(providerErrorUtils.redactProviderMessage(message)).toBe(message);
    }
  });

  it("leaves a sentence that merely names a key alone", () => {
    const message = "the api key you pasted was rejected";
    expect(providerErrorUtils.redactProviderMessage(message)).toBe(message);
  });

  // The `api_key` shape is matched by a scanner instead of a pattern, so the
  // equivalence is proved against the pattern it replaced rather than assumed.
  // This chain is that pattern list verbatim: every case below runs through
  // both it and the shipped scrubber, and the outputs have to be identical. It
  // lives here, in an excluded-from-analysis file, so the pattern that Sonar
  // flags is never reintroduced into the module.
  const MARKER = "[redacted]";
  const REFERENCE_SECRET_PATTERNS: RegExp[] = [
    /\b(?:gsk|csk|sk)[-_][a-z0-9_-]+/gi,
    /bearer\s+[a-z0-9._~+/=-]+/gi,
    /authorization:\s*[^\s;,]+/gi,
    /api[_-]?key["']?\s*[:=]\s*["']?\s*[a-z0-9._~+/=-]+/gi,
  ];

  const referenceRedact = (message: string): string =>
    REFERENCE_SECRET_PATTERNS.reduce(
      (cleaned, pattern) => cleaned.replace(pattern, MARKER),
      message,
    );

  /** True when every character of `needle` occurs in `haystack`, in order. */
  const isSubsequence = (needle: string, haystack: string): boolean => {
    let cursor = 0;
    for (const character of needle) {
      const found = haystack.indexOf(character, cursor);
      if (found === -1) return false;
      cursor = found + 1;
    }
    return true;
  };

  // Every axis the shape is built from. The sweep below crosses them, so a
  // change to any one of them lands in a case rather than in a gap.
  const LABELS = [
    "api_key",
    "API-KEY",
    "Api_Key",
    "apikey",
    "APIKEY",
    "xapi_key",
    "api_keys",
    "api_ke",
    "api_",
    "monkey",
    "key",
  ];
  const BEFORE_SEPARATOR = ["", " ", "  ", "\t", "\n", '"', "'", ' "', " ' "];
  const SEPARATORS = [":", "=", " = ", "\t=\t", ":=", "::", "", " - ", "=>"];
  const AFTER_SEPARATOR = ["", " ", "  ", "\n", '"', "'", ' "', " ' ", ' " '];
  const VALUES = [
    "",
    "abc123",
    "ABC123",
    "abc.def",
    "a_b-c~d+/=-",
    '"abc123"',
    "abc def",
    "!",
    "é",
    "  ",
  ];

  const expectSameAsPattern = (message: string): void => {
    expect(
      providerErrorUtils.redactProviderMessage(message),
      `shipped scrubber disagreed with the pattern on ${JSON.stringify(message)}`,
    ).toBe(referenceRedact(message));
  };

  it("redacts every api key assignment shape the pattern it replaced matched", () => {
    // The whole cross product of the five axes, on its own. This is the part
    // that decides whether the scanner reads the same match out of the same
    // text.
    let compared = 0;
    for (const label of LABELS) {
      for (const before of BEFORE_SEPARATOR) {
        for (const separator of SEPARATORS) {
          for (const after of AFTER_SEPARATOR) {
            for (const value of VALUES) {
              compared += 1;
              expectSameAsPattern(
                `${label}${before}${separator}${after}${value}`,
              );
            }
          }
        }
      }
    }
    // A sweep that silently degenerated into a handful of cases would pass
    // while proving nothing.
    expect(compared).toBe(
      LABELS.length *
        BEFORE_SEPARATOR.length *
        SEPARATORS.length *
        AFTER_SEPARATOR.length *
        VALUES.length,
    );
    expect(compared).toBeGreaterThan(80_000);
  });

  it("redacts the same shapes surrounded by other text", () => {
    // The junk around an assignment matters as much as the assignment: it is
    // what proves the scanner finds the same value with the document's own text
    // around it rather than only in the shapes it was shown bare. Every other
    // element of each axis is enough here, because the sweep above already
    // crossed all of them unwrapped -- and it crosses them there for the strict
    // equality, which a wrapper can break: `api_key:"ABC {"body": "` is a
    // truncated document whose opening quote is not the start of a value but
    // whose closing one is a later field's, and a scanner that reads a quoted
    // value to its closing quote (which is the fix above) has to redact that
    // later field too. There is no structural way to tell the two apart, and
    // redacting more is the direction that errs safely, so what this sweep
    // asserts is the property that matters and still holds everywhere: the
    // shipped scrubber never leaves visible a character the pattern took away,
    // so it reveals a subsequence of what the pattern revealed and may hide more.
    // The sweep above keeps the strict two-sided equality over all 80,190
    // unwrapped shapes, and the named tests in this file are what pin the other
    // direction -- that prose around a secret survives.
    const WRAPPERS = ["", "upstream said: ", ' {"body": "', "} ", " error "];
    const REAL_LABELS = ["api_key", "API-KEY", "apikey"];
    const everyOther = (values: readonly string[]): string[] =>
      values.filter((_value, position) => position % 2 === 0);
    let compared = 0;
    let hidMore = 0;
    for (const label of REAL_LABELS) {
      for (const before of everyOther(BEFORE_SEPARATOR)) {
        for (const separator of everyOther(SEPARATORS)) {
          for (const after of everyOther(AFTER_SEPARATOR)) {
            for (const value of everyOther(VALUES)) {
              const core = `${label}${before}${separator}${after}${value}`;
              for (const prefix of WRAPPERS) {
                for (const suffix of WRAPPERS) {
                  compared += 1;
                  const message = `${prefix}${core}${suffix}`;
                  const shipped =
                    providerErrorUtils.redactProviderMessage(message);
                  const revealedByShip = shipped.split(MARKER).join("");
                  const revealedByPattern = referenceRedact(message)
                    .split(MARKER)
                    .join("");
                  expect(
                    isSubsequence(revealedByShip, revealedByPattern),
                    `shipped scrubber revealed more than the pattern on ${JSON.stringify(message)}`,
                  ).toBe(true);
                  if (shipped !== referenceRedact(message)) hidMore += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(15_000);
    // The relationship above has to be able to differ at all, or it would be a
    // restatement of the equality the sweep above already pins and would go on
    // passing if the quote rule were reverted.
    expect(hidMore).toBeGreaterThan(0);
  });

  it("redacts a second assignment beside the first, and resumes after it", () => {
    const message = `{"api_key":"one"}{"api_key":"two"}`;
    const output = providerErrorUtils.redactProviderMessage(message);
    expect(output).toBe(referenceRedact(message));
    expect(output).toBe('{"[redacted]"}{"[redacted]"}');
  });

  it("scrubs a long whitespace run without super-linear work", () => {
    // A remote end chooses this text and no caller of the scrubber bounds its
    // length, so the cost of a label followed by a long whitespace run and a
    // value the class does not hold is the remote end's to choose. The pattern
    // this replaced let the engine split that one run between its two
    // whitespace quantifiers and retry every split once the value failed, so
    // the work grew with the square of the run. The scanner reads each
    // character once.
    //
    // 150,000 characters took about 11 seconds under the pattern and takes
    // single-digit milliseconds under the scanner, so the 1,000 ms budget is
    // not a close call in either direction.
    const message = "api_key=" + " ".repeat(150_000) + "!";

    const started = Date.now();
    expect(providerErrorUtils.redactProviderMessage(message)).toBe(message);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 1000);
});

describe("an authorization label with a scheme-prefixed value", () => {
  // The label pattern stops at the first space, so `authorization: Digest
  // username="u", realm="r", response="s"` used to redact the scheme word and
  // leave every parameter of the challenge in the string these callers log and
  // persist as error metadata. `response` is what a server computes, and it is
  // as sensitive as the nonce next to it.
  const CHALLENGE = 'response="' + "s3cr3t" + '"';

  it("redacts the whole Digest challenge after a bare authorization label", () => {
    const output = providerErrorUtils.redactProviderMessage(
      'authorization: Digest username="u", realm="r", ' + CHALLENGE,
    );
    expect(output).not.toContain(CHALLENGE);
    expect(output).not.toContain('realm="r"');
    expect(output).toContain("[redacted]");
  });

  it("redacts a proxy-authorization challenge the same way", () => {
    const output = providerErrorUtils.redactProviderMessage(
      "proxy-authorization: Digest nonce=" + CHALLENGE,
    );
    expect(output).not.toContain(CHALLENGE);
  });

  it("keeps the diagnosis that follows the credential", () => {
    const output = providerErrorUtils.redactProviderMessage(
      "authorization: Digest abc is not authorized for this request",
    );
    expect(output).not.toContain("Digest abc ");
    expect(output).toContain("is not authorized for this request");
  });
});

describe("an authorization label inside a JSON body", () => {
  // A JSON body quotes both sides of the separator, and this label scanner
  // wanted a bare `:` straight after the label name. It skipped the whole field,
  // so a Digest challenge a caller put in a request body -- the nonce, the realm
  // and the `response` a server computes -- reached the log file and the
  // persisted error metadata in the clear. The key-shaped fixtures are split at
  // the prefix for the reason the rest of this file's fixtures are.
  const DIGEST_NONCE = "nc" + "7f3a91";
  const UNPREFIXED_CREDENTIAL = "abc1" + "23xyz";

  it.each([
    [
      "a quoted separator and a scheme",
      `{"authorization": "Digest nonce=${DIGEST_NONCE}, realm=eastus"}`,
      '{"[redacted]"}',
    ],
    [
      "no space after the separator",
      `{"authorization":"Digest nonce=${DIGEST_NONCE}, realm=eastus"}`,
      '{"[redacted]"}',
    ],
    [
      "a proxy-authorization field",
      `{"proxy-authorization": "Digest nonce=${DIGEST_NONCE}"}`,
      '{"[redacted]"}',
    ],
    [
      "a quoted value with no scheme word",
      `{"authorization":"${UNPREFIXED_CREDENTIAL}"}`,
      '{"[redacted]"}',
    ],
    [
      "a single-quoted label",
      `{'authorization': 'Digest nonce=${DIGEST_NONCE}'}`,
      "{'[redacted]'}",
    ],
  ])("redacts a JSON authorization field with %s", (_label, body, expected) => {
    const output = providerErrorUtils.redactProviderMessage(body);
    expect(output).not.toContain(DIGEST_NONCE);
    expect(output).not.toContain(UNPREFIXED_CREDENTIAL);
    expect(output).toBe(expected);
  });

  it("stops at the closing quote so the next JSON field survives", () => {
    const output = providerErrorUtils.redactProviderMessage(
      `{"authorization": "Digest nonce=${DIGEST_NONCE}", "model": "llama-3"}`,
    );
    expect(output).not.toContain(DIGEST_NONCE);
    expect(output).toBe('{"[redacted]", "model": "llama-3"}');
  });
});
