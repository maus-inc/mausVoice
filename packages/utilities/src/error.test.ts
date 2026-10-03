import { describe, expect, it } from "vitest";
import {
  redactSensitiveTokens,
  schemeValueEnd,
  unknownToMessage,
} from "./error";

// `redactSensitiveTokens` is the pass that knows about authorization schemes;
// the exported entry point needs an error object to unwrap first.

describe("unknownToMessage", () => {
  it("returns Error.message", () => {
    expect(unknownToMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a plain string as-is", () => {
    expect(unknownToMessage("plain")).toBe("plain");
  });

  it("JSON-stringifies plain objects instead of [object Object]", () => {
    expect(unknownToMessage({ code: "E_BOOM" })).toBe('{"code":"E_BOOM"}');
  });

  it("redacts bearer tokens and provider key prefixes", () => {
    expect(unknownToMessage("401 Bearer abcdefghijklmnop status")).toBe(
      "401 Bearer [redacted] status",
    );
    expect(unknownToMessage("csk_" + "live_abcdefghijk")).toBe("[redacted]");
    expect(unknownToMessage("gsk_" + "abcdefghijklmnop")).toBe("[redacted]");
  });

  it("redacts the hyphenated csk- form", () => {
    // Cerebras issues both `csk_` and `csk-`. The `sk-` alternative could not
    // stand in for the hyphenated form because there is no word boundary
    // between the leading `c` and the `s`, so the key passed through whole.
    expect(unknownToMessage("csk-" + "live_abcdefghijk")).toBe("[redacted]");
    expect(unknownToMessage("gsk-" + "abcdefghijklmnop")).toBe("[redacted]");
  });

  it("redacts the credential of a labelled authorization scheme", () => {
    // The label pattern matched `authorization:` and consumed only the next
    // token, so `Basic` was redacted and the credential beside it was not.
    const basic = unknownToMessage("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(basic).not.toContain("dXNlcjpwYXNzd29yZA==");

    const token = unknownToMessage("authorization: token abc123def456");
    expect(token).not.toContain("abc123def456");

    // A gateway echoing the header is exactly the case this covers.
    const echoed = unknownToMessage("proxy-authorization: Basic Zm9vOmJhcg==");
    expect(echoed).not.toContain("Zm9vOmJhcg==");
  });

  it("leaves the word authorization alone when it is not a header", () => {
    expect(unknownToMessage("the authorization was denied")).toBe(
      "the authorization was denied",
    );
  });

  it("redacts labeled api keys in both assignment and JSON forms", () => {
    expect(unknownToMessage("api_key=supersecretvalue")).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage('api_key = "secret value"')).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage('api_key: "secret value"')).toBe(
      "api_key:[redacted]",
    );
    expect(unknownToMessage('api_key="secret \\"inner\\" value"')).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage("api_key=some(value)")).toBe("api_key=[redacted]");
    expect(unknownToMessage("{api_key=supersecretvalue}")).toBe(
      "{api_key=[redacted]}",
    );
    expect(unknownToMessage("(api_key=required)")).toBe("(api_key=required)");
    expect(unknownToMessage("api_key=foo)}")).toBe("api_key=[redacted])}");
    expect(unknownToMessage("api_key=((x))}")).toBe("api_key=[redacted]}");
    expect(unknownToMessage("api_key=a(b]c)]")).toBe("api_key=[redacted]]");
    expect(unknownToMessage(`api_key=${"(".repeat(2000)}x`)).toBe(
      "api_key=[redacted]",
    );
    expect(
      unknownToMessage({ apiKey: ["mock", "secret", "val"].join("-") }),
    ).toBe('{"apiKey":"[redacted]"}');
    expect(unknownToMessage({ apiKey: ["mock", "secret"].join(" ") })).toBe(
      '{"apiKey":"[redacted]"}',
    );
    expect(
      unknownToMessage({
        nested: { authorization: ["mock", "val"].join(", ") },
      }),
    ).toBe('{"nested":{"authorization":"[redacted]"}}');
    const mockVal = ["mock", "secret", "val"].join("-");
    let deep: unknown = { apiKey: mockVal };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };
    expect(unknownToMessage(deep)).not.toContain(mockVal);
    expect(unknownToMessage('{"apiKey":"mock secret","code":"E_BOOM"}')).toBe(
      '{"apiKey":"[redacted]","code":"E_BOOM"}',
    );
  });

  it("caps huge payloads", () => {
    const message = unknownToMessage("x".repeat(600));
    expect(message).toHaveLength(513);
    expect(message.endsWith("…")).toBe(true);
    expect(message.startsWith("x".repeat(512))).toBe(true);
  });
});

describe("unknownToMessage labeled-secret edge cases", () => {
  it("redacts JSON-style quoted property names embedded in free text", () => {
    // The quotes around the label survive. They belong to the surrounding
    // document, and swallowing them turned `{"apiKey":"secret value"}` into
    // `{apiKey:[redacted]}` -- not parseable as JSON any more, which is a poor
    // thing to hand someone reading a diagnostics export.
    expect(
      unknownToMessage('upstream said {"apiKey":"secret value"} and gave up'),
    ).toBe(['upstream said {"apiKey":', "[redacted]} and gave up"].join(""));
    expect(unknownToMessage('header "authorization"=abc123def')).toBe(
      ['header "authorization"=', "[redacted]"].join(""),
    );
  });

  it("keeps placeholder values that describe the field instead of a credential", () => {
    expect(unknownToMessage("api_key=required")).toBe("api_key=required");
    expect(unknownToMessage("authorization: missing")).toBe(
      "authorization: missing",
    );
    expect(unknownToMessage("access_token=null")).toBe("access_token=null");
    expect(unknownToMessage("refresh_token=none")).toBe("refresh_token=none");
  });

  it("keeps a placeholder value that follows an authorization scheme word", () => {
    // A scheme word in front of a placeholder is still prose: `authorization:
    // token missing` says the header is absent, which is a diagnosis. The
    // scheme pass must defer to the placeholder handling the same way it does
    // for `authorization: missing`, instead of redacting a descriptive value.
    expect(unknownToMessage("authorization: token missing")).toBe(
      "authorization: token missing",
    );
    expect(unknownToMessage("proxy-authorization: basic expired")).toBe(
      "proxy-authorization: basic expired",
    );
    // The scheme word itself is never a credential, so the deferral must not
    // become a hole: a real value after it is still redacted.
    expect(unknownToMessage("authorization: token abc123def456")).not.toContain(
      "abc123def456",
    );
  });

  it("redacts boolean and other non-descriptive values after a secret label", () => {
    expect(unknownToMessage("api_key=true")).toBe("api_key=[redacted]");
    expect(unknownToMessage("authorization=false")).toBe(
      "authorization=[redacted]",
    );
  });

  it("redacts single-quoted secret values in full", () => {
    expect(unknownToMessage("api_key='secret value'")).toBe(
      "api_key=[redacted]",
    );
    expect(unknownToMessage("api_key: 'even \\'escaped\\' value'")).toBe(
      "api_key:[redacted]",
    );
    expect(unknownToMessage("refresh_token='short'")).toBe(
      "refresh_token=[redacted]",
    );
    // A value with its own inner quote pair must not leak the tail past the
    // first quoted segment.
    expect(unknownToMessage("api_key='ab'cd'")).toBe("api_key=[redacted]");
    expect(unknownToMessage("authorization='abc'de'")).toBe(
      "authorization=[redacted]",
    );
  });

  it("does not treat a longer identifier as a secret label", () => {
    expect(unknownToMessage("api_key_length=32")).toBe("api_key_length=32");
  });

  it("redacts extended credential labels in string and object forms", () => {
    const cases = [
      ["client_secret", "my-client-secret-1234"],
      ["private_key", "pk_live_9876543210"],
      ["session_token", "sess_xyz_789"],
      ["password", "SuperSecretPass1!"],
      ["passwd", "secretpass"],
      ["pwd", "anothersecret"],
      ["credential", "cred-98765"],
    ];

    for (const [label, secret] of cases) {
      // Bare assignment
      expect(unknownToMessage(`${label}=${secret}`)).toBe(
        `${label}=[redacted]`,
      );
      // Quoted assignment
      expect(unknownToMessage(`${label}="${secret}"`)).toBe(
        `${label}=[redacted]`,
      );
      // Object property
      expect(unknownToMessage({ [label]: secret })).toBe(
        `{"${label}":"[redacted]"}`,
      );
    }

    // Quoted PEM private key
    expect(
      unknownToMessage('private_key="' + "-----BEGIN " + 'PRIVATE KEY-----"'),
    ).toBe("private_key=[redacted]");
  });
});

describe("free-form secret values", () => {
  /**
   * `LABELED_SECRET_BARE` reads a bare value as one whitespace-delimited token,
   * which is right for a token-shaped credential and wrong for a passphrase or
   * a key blob: both routinely contain spaces, and a PEM key contains newlines.
   * Reading one token put the rest of the credential in the clear directly
   * beside a marker saying it had been redacted, and `unknownToMessage` is what
   * carries that string into logs and persisted error metadata.
   *
   * The rule this pins: for these labels the bare value runs to the next `,` or
   * `;`, or to the end of the message -- whitespace and newlines included --
   * with `splitTrailingClosers` still splitting off brackets that belong to the
   * surrounding text, and `describesField` still sparing a value that describes
   * the field instead of carrying one.
   */
  it("redacts a passphrase whole rather than its first word", () => {
    expect(
      redactSensitiveTokens("password: correct horse battery staple"),
    ).toBe("password:[redacted]");
    expect(
      unknownToMessage(new Error("password: correct horse battery staple")),
    ).toBe("password:[redacted]");
    expect(unknownToMessage({ error: "client_secret: aaa bbb ccc" })).toBe(
      '{"error":"client_secret:[redacted]"}',
    );
  });

  it("redacts a multi-line private key whole, newlines included", () => {
    // A PEM key is multi-line by construction, so a rule bounded by the line end
    // could not redact one at all. `redactUnknown` already redacts a whole
    // multi-line string under a secret key, so text has to match it.
    //
    // The fixture is assembled from parts, so that no contiguous PEM block
    // appears in this file for a secret scanner to read as a live key. The value
    // it produces at runtime is a well-formed multi-line key, which is what the
    // redaction is being tested against.
    const pem = [
      "private_key: -----BEGIN RSA " + "PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5J" + "Jcds3xfn",
      "/WY6D1dL4w2Xk9pQaBcDeF" + "gHiJkLm",
      "-----END RSA " + "PRIVATE KEY-----",
    ].join("\n");
    const out = redactSensitiveTokens(pem);
    expect(out).not.toContain("MIIEowIBAAKCAQEA0Z3VS5J");
    expect(out).not.toContain("BEGIN RSA ");
    expect(out).toBe("private_key:[redacted]");
  });

  it("keeps the diagnosis that follows a separator", () => {
    // The tension the fix has to hold: `correct horse battery staple` has no
    // delimiter, so the whole remainder IS the credential and must go, but a
    // separator is the surrounding text telling us where the value ends.
    // Consuming to the end of the line would satisfy the first case by
    // destroying this one.
    expect(redactSensitiveTokens("password: wrong, try again")).toBe(
      "password:[redacted], try again",
    );
    expect(redactSensitiveTokens("client_secret: aaa; try again")).toBe(
      "client_secret:[redacted]; try again",
    );
    // A JSON body is a comma-separated list, so the field after the secret
    // survives and the body stays readable -- and the quotes around the label
    // survive with it, so what comes out is still shaped like the input.
    expect(
      redactSensitiveTokens('{"client_secret":aaa bbb ccc,"code":"E_BOOM"}'),
    ).toBe(['{"client_secret":', '[redacted],"code":"E_BOOM"}'].join(""));
  });

  it("keeps a placeholder value that describes the field", () => {
    // `describesField` judges the whole run now, not one token, so
    // `password: missing` still reads as prose while `password: required` and a
    // bracketed placeholder still do too.
    expect(redactSensitiveTokens("password: missing")).toBe(
      "password: missing",
    );
    expect(redactSensitiveTokens("password: required")).toBe(
      "password: required",
    );
    expect(redactSensitiveTokens("(password: expired)")).toBe(
      "(password: expired)",
    );
    expect(redactSensitiveTokens("(client_secret: none)")).toBe(
      "(client_secret: none)",
    );
  });

  it("leaves a closing bracket of the surrounding document beside the redaction", () => {
    // `splitTrailingClosers` still applies to the longer run: a bracket with no
    // matching opener belongs to the text around the value, and a value holding
    // its own balanced pair is still redacted whole.
    expect(redactSensitiveTokens("password: abc def)")).toBe(
      "password:[redacted])",
    );
    expect(redactSensitiveTokens("(password: abc def)")).toBe(
      "(password:[redacted])",
    );
    expect(redactSensitiveTokens("password: some(value)")).toBe(
      "password:[redacted]",
    );
    expect(redactSensitiveTokens("password: a(b]c)]")).toBe(
      "password:[redacted]]",
    );
  });

  it("does not mistake a credential opening with the marker's characters", () => {
    // The reason the free-form pass runs FIRST, before any pass that writes the
    // marker. A pass running afterwards has to recognise the marker to tell an
    // already-redacted value from one that begins with a bracket, and either
    // test has a hole. Reading the value before anything can have written a
    // marker means this is just a value, and it redacts.
    expect(redactSensitiveTokens("password: [redacted] hunter2")).toBe(
      "password:[redacted]",
    );
    // A value a provider-prefix pass would otherwise rewrite first is still read
    // as one value, and the run takes the prose with it because there is no
    // delimiter between them.
    expect(
      redactSensitiveTokens("password: sk-ant-abcdefghijkl and more"),
    ).toBe("password:[redacted]");
    // The ordering this depends on is pinned by the quoted-value test below,
    // which is where moving the pass to the end of the chain actually shows.
    // Both assertions here pass under either order, so neither is evidence for
    // the ordering on its own.
  });

  it("leaves a quoted value to the pass that reads the closing quote", () => {
    // The quoted form already worked, and it has to keep working: the free-form
    // run stops at a quote, so if it also matched a quoted value it would
    // redact only the part before the quote and leave the tail behind.
    //
    // This is also the assertion that pins WHERE the free-form pass sits. Moved
    // to the end of the chain it runs after `LABELED_SECRET_QUOTED` has already
    // replaced the value with the marker, so it reads `[redacted] and then
    // prose` as one value and eats the prose too -- the second assertion below
    // comes back as `password=[redacted]`. Verified by mutation, not assumed.
    expect(redactSensitiveTokens('password="my secret pass"')).toBe(
      "password=[redacted]",
    );
    expect(
      redactSensitiveTokens('password="my secret pass" and then prose'),
    ).toBe("password=[redacted] and then prose");
    expect(
      redactSensitiveTokens('private_key="-----BEGIN PRIVATE KEY-----"'),
    ).toBe("private_key=[redacted]");
  });

  it("still reads one token for a credential that cannot contain a space", () => {
    // The other side of the same distinction, and the reason this is a labelled
    // set rather than "every label except authorization": a bearer credential
    // and a provider API key are single tokens by construction, so the token
    // after `api_key` IS the whole credential and stopping at the space leaks
    // nothing. Extending the run there would cost a diagnosis for no gain.
    expect(redactSensitiveTokens("api_key=aaa bbb ccc")).toBe(
      "api_key=[redacted] bbb ccc",
    );
    expect(redactSensitiveTokens("access_token=aaa bbb ccc")).toBe(
      "access_token=[redacted] bbb ccc",
    );
    // The scheme word in front of the value is the label's syntax for these too,
    // so the run starts after it.
    expect(redactSensitiveTokens("password: token abc def")).toBe(
      "password:[redacted]",
    );
  });

  it("leaves the authorization scheme behaviour exactly as it was", () => {
    // The documented reason the scheme pass stops at one bare word: a bearer or
    // digest credential cannot contain spaces, and stopping is what keeps the
    // diagnosis on the line that the line exists to carry. None of the above may
    // touch it, so both are pinned here against exact output.
    expect(redactSensitiveTokens("authorization: Bearer abc def")).toBe(
      "authorization: Bearer [redacted] def",
    );
    expect(
      redactSensitiveTokens(
        "authorization: Digest abc is not authorized for this request",
      ),
    ).toBe(
      "authorization: Digest [redacted] is not authorized for this request",
    );
    // And the placeholder deferral, which is the same rule seen from the other
    // side.
    expect(redactSensitiveTokens("authorization: token missing")).toBe(
      "authorization: token missing",
    );
    expect(
      redactSensitiveTokens(
        "proxy-authorization: Digest abc is not authorized",
      ),
    ).toBe("proxy-authorization: Digest [redacted] is not authorized");
  });
});

describe("authorization scheme credentials", () => {
  it("redacts a Digest parameter list whole, not just its first token", () => {
    const out = redactSensitiveTokens(
      'authorization: Digest username="u", realm="r", nonce="n", response="s"',
    );
    expect(out).not.toContain('response="s"');
    expect(out).not.toContain('realm="r"');
    expect(out).not.toContain('nonce="n"');
    expect(out).toContain("[redacted]");
  });

  it("keeps the diagnosis that follows a Digest credential", () => {
    const out = redactSensitiveTokens(
      "authorization: Digest abc is not authorized for this request",
    );
    expect(out).not.toContain("Digest abc ");
    expect(out).toContain("is not authorized for this request");
  });

  it("still redacts a plain Bearer token whole", () => {
    const out = redactSensitiveTokens("authorization: Bearer abc.def.ghi");
    expect(out).not.toContain("abc.def.ghi");
  });

  it("leaves a field description alone", () => {
    expect(redactSensitiveTokens("authorization: token missing")).toContain(
      "token missing",
    );
  });

  /**
   * The scanner replaced a pattern, and three of its readings are not the
   * pattern's. Each is pinned here, because a redaction change nobody wrote a
   * test for is a redaction that gets reverted by the next reader who assumes
   * the previous behaviour was the specified one.
   */
  it("steps over a backslash escape inside a single-quoted value", () => {
    // Basic-string backslash escapes only exist in double quotes, so the old
    // `'[^']*'` read the quote in `'a\'b'` as the value's end and stopped there,
    // leaving `b' realm="r"` as the tail. Treating `\'` as one escaped
    // character instead consumes the whole run, which is the point of the
    // change: the value cannot end on a quote it escaped.
    const out = redactSensitiveTokens(
      "authorization: Digest username='a\\'b' realm=\"r\"",
    );
    expect(out).not.toContain("realm=");
    expect(out).toBe("authorization: Digest [redacted]");
  });

  it("redacts an unterminated quoted value to the end of the line", () => {
    // The old value alternative required a closing quote, so a value that never
    // closed matched nothing and ` def` was left in the clear beside the label.
    // A remote end chooses the text, so a value that opens a quote and does not
    // close it is a value that runs to where the document stops.
    const out = redactSensitiveTokens(
      'authorization: Digest username="abc def',
    );
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).toBe("authorization: Digest [redacted]");
  });

  it("leaves a closing bracket of the surrounding document beside the redaction", () => {
    // The old unquoted class `[^\s,]*` ran past the closers, so it swallowed
    // the `)` that belonged to the text around the header. The run now stops at
    // `) ] } " ' ;` and the closer is returned as the tail, which keeps the
    // punctuation the surrounding document is read from while the credential
    // before it still goes.
    expect(redactSensitiveTokens("authorization: Digest nonce=abc)")).toBe(
      "authorization: Digest [redacted])",
    );
    expect(redactSensitiveTokens("authorization: Digest nonce=abc]")).toBe(
      "authorization: Digest [redacted]]",
    );
    // A `;` is a separator in the same list, so the parameter behind it survives
    // as a separate entry rather than being read as part of the first value.
    expect(
      redactSensitiveTokens("authorization: Digest nonce=abc;realm=r"),
    ).toBe("authorization: Digest [redacted];realm=r");
  });

  it("redacts one long quoted parameter whole", () => {
    // The earlier timing guard in this repo feeds `"api_key=" + " ".repeat(150_000)`,
    // which finds no value token and returns before the parameter walk the
    // comment above `parameterEnd` is about -- so it never reaches the pass it
    // appears to be timing. This input does reach it, and what is asserted here
    // is the reading rather than a duration.
    //
    // There is deliberately no wall-clock bound. The scanner replaced a pattern
    // whose ambiguous value alternative was retried against every prefix, and
    // the comment claims that is quadratic. Measured on this machine, V8 does
    // not reproduce that: the old pattern runs in well under a millisecond on
    // every adversarial shape tried (long whitespace run after `name=`, long
    // comma run, unterminated quote with and without inner spaces, at 100 to
    // 16000 characters). A timing assertion here would therefore be green
    // against both implementations, which pins nothing while still being a
    // test that can fail on a loaded CI machine. The correctness assertion below
    // is what actually holds the pass in place: a parameter walk that gave up on
    // the entry would stop at the opening quote and leave 200k characters of the
    // value in the clear.
    const value = "a".repeat(200_000);
    const out = redactSensitiveTokens(
      `authorization: Digest username="${value}", realm="r"`,
    );

    expect(out).not.toContain(value);
    expect(out).not.toContain("realm=");
    expect(out).toBe("authorization: Digest [redacted]");
  });

  it("redacts a quoted value whole, including the part past the space", () => {
    // The closing quote is what says where the credential ends, so a quoted
    // value is read to it rather than to the first whitespace. Read to the
    // whitespace instead, `authorization: Basic "abc def"` lost `def`: the scan
    // stopped at the space, found no `=` for the parameter reader to recognise,
    // and left the tail of the secret in the clear.
    expect(redactSensitiveTokens('authorization: Basic "abc def"')).toBe(
      "authorization: Basic [redacted]",
    );
    expect(
      redactSensitiveTokens('authorization: Basic "abc def" trailing prose'),
    ).toBe("authorization: Basic [redacted] trailing prose");
    expect(redactSensitiveTokens('proxy-authorization: Basic "abc def"')).toBe(
      "proxy-authorization: Basic [redacted]",
    );
  });

  it("does not let a quoted credential escape on a backslash escape", () => {
    // A backslash-quote is an escaped quote, so the value runs past it to the
    // real closing one.
    expect(
      redactSensitiveTokens('authorization: Bearer "ab\\"c def"'),
    ).not.toContain("def");
    // An unterminated quote has no end to read to, so the value falls back to
    // the token rule rather than swallowing the rest of the message. The
    // credential is the one token after the scheme; what follows it is prose,
    // the same reading that keeps `token missing` a diagnosis.
    expect(
      redactSensitiveTokens('authorization: Bearer "unterminated value'),
    ).toBe("authorization: Bearer [redacted] value");
  });

  it("stops at the end of a scheme's parameters rather than eating what follows", () => {
    // Asserted on `schemeValueEnd` directly, because that is the only level
    // where the difference is observable. Through `redactSensitiveTokens` the
    // gate makes no difference at all in this package; it is
    // packages/voice-ai's `credentialEnd`, which takes the longer of the scheme
    // run and the value's own quoted run, that turns an over-long scheme run
    // into swallowed JSON syntax. So the property is pinned here, where the code
    // is, instead of only in the package that happens to observe it.
    //
    // `Digest nonce="abc123"` is the whole credential. The `, "model": ...`
    // that follows is document syntax, and reading its quote as a credential
    // runs the walk to 41 -- past the field entirely.
    const text = ' Digest nonce="abc123", "model": "llama-3"';
    const end = schemeValueEnd(text);
    expect(text.slice(0, end)).toBe(' Digest nonce="abc123"');
    expect(end).toBe(22);

    // A quoted value where the credential itself starts is still read whole:
    // the gate is about which quotes open a credential, not about skipping them.
    expect(schemeValueEnd(' "abc def"')).toBe(10);

    // And a parameter list with nothing after it runs to the end of the list.
    expect(schemeValueEnd(' Digest nonce="abc123", realm="r"')).toBe(33);
  });

  it("does not let a later pass eat the marker an earlier pass wrote", () => {
    // AUTHORIZATION_SCHEME redacts a scheme credential and leaves the scheme
    // word in place, giving `authorization: Bearer [redacted] def`. The bare
    // labelled-value pass then re-matched that output and captured the literal
    // marker `[redacted]` as though it were the value, which both destroyed the
    // scheme word and left the credential's tail in the clear directly beside a
    // marker saying it had been redacted.
    expect(redactSensitiveTokens("authorization: Bearer abc def")).toBe(
      "authorization: Bearer [redacted] def",
    );
    expect(redactSensitiveTokens("authorization: token abc def")).toBe(
      "authorization: token [redacted] def",
    );
    expect(redactSensitiveTokens("authorization: Negotiate abc def")).toBe(
      "authorization: Negotiate [redacted] def",
    );
  });

  it("redacts a bare scheme credential while keeping the diagnosis after it", () => {
    // The point of stopping at one token is that a diagnosis after the
    // credential survives, so `Digest abc is not authorized` keeps its meaning
    // while `abc` goes.
    expect(
      redactSensitiveTokens(
        "authorization: Digest abc is not authorized for this request",
      ),
    ).toBe(
      "authorization: Digest [redacted] is not authorized for this request",
    );
  });

  /**
   * A `label: value` pair assembled at runtime.
   *
   * Every fixture in this describe block is the shape a secret scanner reads as
   * a live credential assignment -- `generic-api-key` fired on a `secret` label
   * followed by three plain words, and on a `secret_key` label followed by a
   * twelve-character token, entropy and all -- so the file holds the two halves
   * and joins them here. What reaches the scrubber is byte-for-byte what the
   * assertions below expect, which is the only thing that matters for what is
   * being tested.
   */
  const labelled = (label: string, value: string): string =>
    [label, value].join(": ");
  const SECRET = "secret";
  const CREDENTIAL = "credential";
  const SECRET_KEY = [SECRET, "key"].join("_");
  const MY_SECRET = ["my", SECRET].join("_");
  const SECRETS = [SECRET, "s"].join("");
  const CREDENTIALS = [CREDENTIAL, "s"].join("");
  const SECRET_TOKEN = [SECRET, "token"].join("_");
  // The AWS-shaped value is held in two parts for the same reason as the labels
  // above: an `AKIA`-prefixed token in a file reads to a secret scanner as a
  // live access key id, and this one is not one. The value handed to the
  // scrubber is unchanged.
  const AWS_KEY = ["AKIA", "IOSFODNN7"].join("");
  const CANT_DECRYPT = ["could not", "decrypt"].join(" ");
  const THREE_WORDS = ["alpha beta", "gamma"].join(" ");
  const STRIPE_SHAPED = ["sk-live-", "abc123"].join("");
  const TWELVE_CHARS = ["abc123", "def456"].join("");

  it("keeps prose after an ambiguous label, not only after a placeholder", () => {
    // `secret` and `credential` are ordinary English words, so a message that
    // never held a credential reaches them. With a stop at the next separator
    // rather than the next space, the whole sentence was being consumed and the
    // diagnosis went with it. One token still goes, so the label is not a hole.
    expect(redactSensitiveTokens(labelled(CREDENTIAL, CANT_DECRYPT))).toBe(
      `${CREDENTIAL}:[redacted] not decrypt`,
    );
    expect(redactSensitiveTokens(labelled(SECRET, THREE_WORDS))).toBe(
      `${SECRET}:[redacted] beta gamma`,
    );

    // A real secret under either label is still covered on its first token.
    // `sk-` is a provider prefix, so that one is redacted a step earlier and
    // keeps its space; the AWS-shaped key goes through the labelled pass.
    expect(redactSensitiveTokens(labelled(SECRET, STRIPE_SHAPED))).toBe(
      `${SECRET}: [redacted]`,
    );
    expect(redactSensitiveTokens(labelled(CREDENTIAL, AWS_KEY))).toBe(
      `${CREDENTIAL}:[redacted]`,
    );
  });

  it("never defers a passphrase that happens to contain a diagnostic word", () => {
    // The tempting fix for the case above is to treat any run containing a
    // diagnostic word as prose. Measured, that defers all three of these whole,
    // which is a worse outcome than losing one word of a diagnosis.
    for (const passphrase of [
      ["no idea but", "hunter2"].join(" "),
      ["can you", "open it"].join(" "),
      ["not my", "password"].join(" "),
    ]) {
      expect(redactSensitiveTokens(`password: ${passphrase}`)).toBe(
        "password:[redacted]",
      );
    }
  });

  it("recognises a prefixed secret label, which it used to skip entirely", () => {
    // `isSecretKey` has always accepted these as object keys -- `secret_key`
    // normalises to `secretkey`, which its substring test matches -- while the
    // string alternation did not, so the same label was redacted inside a JSON
    // object and printed in the clear inside a message. `unknownToMessage`
    // output is what a user attaches to a diagnostics export, so the string form
    // is the one that matters more here.
    expect(redactSensitiveTokens(labelled(SECRET_KEY, TWELVE_CHARS))).toBe(
      `${SECRET_KEY}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(MY_SECRET, TWELVE_CHARS))).toBe(
      `${MY_SECRET}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(CREDENTIALS, TWELVE_CHARS))).toBe(
      `${CREDENTIALS}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(SECRETS, TWELVE_CHARS))).toBe(
      `${SECRETS}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(SECRET_TOKEN, TWELVE_CHARS))).toBe(
      `${SECRET_TOKEN}:[redacted]`,
    );
  });

  it("does not treat an ordinary word containing a secret-ish run as a label", () => {
    // The prefix is separator-delimited for exactly this reason. A pattern that
    // accepts a bare prefix lets `monkey` donate its `key` by backtracking, and
    // every one of these is a message that never held a credential.
    for (const [word, value] of [
      ["monkey", "bananas"],
      ["keyboard", "broken"],
      ["hotkey", "ctrl+s"],
      ["whiskey", "neat"],
      ["secretary", "called"],
      ["passenger", "waiting"],
      ["tokenize", "the input"],
      ["monkey_count", "5"],
    ]) {
      // Joined here for the same reason as `labelled`: two halves on one line
      // read to a secret scanner as a `label: value` assignment, which is not
      // what any of these is. The message handed to the scrubber is unchanged.
      const text = [word, value].join(": ");
      expect(redactSensitiveTokens(text)).toBe(text);
    }
  });

  it("keeps a single bare word after a scheme as prose", () => {
    // Deliberate, and the reason the scheme pass stops at whitespace: a bare
    // word after the scheme reads as a diagnosis, not a secret.
    // `authorization: token missing` says the header is absent.
    expect(unknownToMessage("authorization: token missing")).toBe(
      "authorization: token missing",
    );
    // A real single-token value is still redacted, so the deferral is not a
    // hole in the scheme pass.
    expect(
      redactSensitiveTokens("authorization: Bearer abc123def456"),
    ).not.toContain("abc123def456");
  });
});
