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
  const REFERENCE_SECRET_PATTERNS: RegExp[] = [
    /\b(?:gsk|csk|sk)[-_][a-z0-9_-]+/gi,
    /bearer\s+[a-z0-9._~+/=-]+/gi,
    /authorization:\s*[^\s;,]+/gi,
    /api[_-]?key["']?\s*[:=]\s*["']?\s*[a-z0-9._~+/=-]+/gi,
  ];

  const referenceRedact = (message: string): string =>
    REFERENCE_SECRET_PATTERNS.reduce(
      (cleaned, pattern) => cleaned.replace(pattern, "[redacted]"),
      message,
    );

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
  const AFTER_SEPARATOR = [
    "",
    " ",
    "  ",
    "\n",
    '"',
    "'",
    ' "',
    " ' ",
    ' " ',
  ];
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
              expectSameAsPattern(`${label}${before}${separator}${after}${value}`);
            }
          }
        }
      }
    }
    // A sweep that silently degenerated into a handful of cases would pass
    // while proving nothing.
    expect(compared).toBe(LABELS.length * BEFORE_SEPARATOR.length *
      SEPARATORS.length * AFTER_SEPARATOR.length * VALUES.length);
    expect(compared).toBeGreaterThan(80_000);
  });

  it("redacts the same shapes surrounded by other text", () => {
    // The junk around an assignment matters as much as the assignment: it is
    // what proves the scanner stops where the pattern stopped rather than
    // redacting more of the sentence or less of the value than it did. Every
    // other element of each axis is enough here, because the sweep above
    // already crossed all of them unwrapped.
    const WRAPPERS = ["", "upstream said: ", ' {"body": "', "} ", " error "];
    const REAL_LABELS = ["api_key", "API-KEY", "apikey"];
    const everyOther = (values: readonly string[]): string[] =>
      values.filter((_value, position) => position % 2 === 0);
    let compared = 0;
    for (const label of REAL_LABELS) {
      for (const before of everyOther(BEFORE_SEPARATOR)) {
        for (const separator of everyOther(SEPARATORS)) {
          for (const after of everyOther(AFTER_SEPARATOR)) {
            for (const value of everyOther(VALUES)) {
              const core = `${label}${before}${separator}${after}${value}`;
              for (const prefix of WRAPPERS) {
                for (const suffix of WRAPPERS) {
                  compared += 1;
                  expectSameAsPattern(`${prefix}${core}${suffix}`);
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(15_000);
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
