import { describe, expect, it } from "vitest";
import {
  redactSensitiveTokens,
  schemeValueEnd,
  unknownToMessage,
} from "./error";

// `redactSensitiveTokens` is the pass that knows about authorization schemes;
// the exported entry point needs an error object to unwrap first.

// `redactUnknown` walks the real object graph, and an SDK error body routinely hangs one
// object off several keys. `seen` used to be add-only, so the marker it produced meant
// "already visited" rather than "on a cycle" -- a plain DAG rendered as
// `{ a: {...}, b: "[Circular]" }`, asserting a cycle that does not exist and dropping the
// second copy.
describe("unknownToMessage on a shared reference", () => {
  it("renders both copies of an object referenced twice", () => {
    const shared = { host: "api.example.com", status: 500 };
    expect(unknownToMessage({ a: shared, b: shared })).toBe(
      '{"a":{"host":"api.example.com","status":500},' +
        '"b":{"host":"api.example.com","status":500}}',
    );
  });

  it("renders a shared object repeated inside an array", () => {
    const shared = { id: 7 };
    expect(unknownToMessage([shared, shared])).toBe('[{"id":7},{"id":7}]');
  });

  it("still marks a real cycle", () => {
    // The marker must not simply be gone. A cycle re-enters an ANCESTOR whose entry has
    // not been removed yet, which is why removing on the way out is safe.
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(unknownToMessage(node)).toBe('{"name":"root","self":"[Circular]"}');
  });

  it("still marks a two-object cycle", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    expect(unknownToMessage(a)).toBe(
      '{"name":"a","b":{"name":"b","a":"[Circular]"}}',
    );
  });

  it("still marks an array that contains itself", () => {
    const list: unknown[] = [1];
    list.push(list);
    expect(unknownToMessage(list)).toBe('[1,"[Circular]"]');
  });

  it("still redacts a credential inside a shared object", () => {
    // The fix changes which objects are REVISITED, not whether they are inspected, so a
    // shared object carrying a credential is still redacted on every appearance.
    const shared = { authorization: "Bearer sk-secret-value" };
    const rendered = unknownToMessage({ a: shared, b: shared });
    expect(rendered).not.toContain("sk-secret-value");
    // The marker is lowercase `[redacted]` -- see REDACTED in error.ts.
    expect(rendered.match(/\[redacted\]/g)).toHaveLength(2);
  });
});

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

  it("never caps a message in the middle of a surrogate pair", () => {
    // The detector, plus a control that proves the detector works. Without the
    // control this test could pass by never finding anything: an earlier version
    // of it did exactly that, because it only flagged a lone unit that sat at the
    // END of the string, and the ellipsis the cap appends sits after it.
    const loneSurrogateAt = (text: string): number => {
      for (let i = 0; i < text.length; i += 1) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
          if (next < 0xdc00 || next > 0xdfff) return i;
          i += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          return i;
        }
      }
      return -1;
    };
    expect(loneSurrogateAt(`a\uD83Cb`)).toBe(1);
    expect(loneSurrogateAt("a\u{1F389}b")).toBe(-1);

    // Every pad length, with the astral character in the middle, at the end and
    // at the start. Before the fix, pad 511 in the middle shape was the single
    // failing case in 1..700 -- the lead surrogate lands on index 511 and the cap
    // cuts at 512, taking the trail unit and leaving the lead behind.
    for (let pad = 1; pad <= 700; pad += 1) {
      const filler = "a".repeat(pad);
      for (const message of [
        `${filler}\u{1F389}tail`,
        `${filler}\u{1F389}`,
        `\u{1F389}${filler}`,
      ]) {
        const capped = unknownToMessage(new Error(message));
        expect(loneSurrogateAt(capped), `pad ${pad}`).toBe(-1);
        expect(capped, `pad ${pad}`).not.toContain("\uFFFD");
      }
    }
  });

  it("keeps an astral character that does not straddle the cap", () => {
    // The fix gives up one code unit at the boundary. It must not start dropping
    // astral characters everywhere, which is what a blunt "strip them" fix would do.
    expect(unknownToMessage(new Error("\u{1F389} ok"))).toBe("\u{1F389} ok");
    expect(unknownToMessage(new Error("ok \u{1F389}"))).toBe("ok \u{1F389}");
    const short = "a".repeat(400) + "\u{1F389}" + "b".repeat(400);
    expect(unknownToMessage(new Error(short))).toContain("\u{1F389}");
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
  const CLIENT_SECRET = ["client", "secret"].join("_");
  const SESSION_TOKEN = ["session", "token"].join("_");
  // Provider-qualified credential labels in the `<provider>_api_key` spelling.
  //
  // One entry per provider module this repo actually ships, which is the list
  // that was previously six of seventeen while the comment claimed every one --
  // so the claim was checkable and wrong. Widening it is not cosmetic: it pins
  // the tier-1 rule against the real provider surface rather than a sample of it.
  //
  // NOT every credential this repo handles. Azure's is the `Ocp-Apim-
  // Subscription-Key` header, which no `<provider>_api_key` spelling matches, and
  // which stays the responsibility of `apps/desktop/src`'s own redactor. That is
  // stated rather than glossed because "every provider" would be false again.
  const PROVIDER_QUALIFIED = [
    ["aldea", "api", "key"].join("_"),
    ["anthropic", "api", "key"].join("_"),
    ["assemblyai", "api", "key"].join("_"),
    ["azure", "api", "key"].join("_"),
    ["cerebras", "api", "key"].join("_"),
    ["claude", "api", "key"].join("_"),
    ["deepgram", "api", "key"].join("_"),
    ["deepseek", "api", "key"].join("_"),
    ["elevenlabs", "api", "key"].join("_"),
    ["gemini", "api", "key"].join("_"),
    ["gladia", "api", "key"].join("_"),
    ["google", "api", "key"].join("_"),
    ["groq", "api", "key"].join("_"),
    ["openai", "api", "key"].join("_"),
    ["openrouter", "api", "key"].join("_"),
    ["speaches", "api", "key"].join("_"),
    ["xai", "api", "key"].join("_"),
  ];
  const AZURE_KEY_NUMBERED = ["azure", "api", "key", "2"].join("_");
  // camelCase credential labels, written the way a TypeScript caller writes them.
  const CAMEL_CREDENTIAL_KEYS = [
    ["openai", "Api", "Key"].join(""),
    ["azure", "Api", "Key"].join(""),
    ["auth", "Token"].join(""),
    ["signing", "Key"].join(""),
    ["encryption", "Key"].join(""),
    ["user", "Password"].join(""),
    ["db", "Password"].join(""),
    ["client", "Secret"].join(""),
    ["private", "Key"].join(""),
    ["session", "Token"].join(""),
  ];
  // camelCase words that are not credentials, including the two that only fail
  // because folding produces a form the holder rule rejects.
  // A qualified camelCase label: the qualifier needs a separator to be seen, and
  // in free text it has none.
  const QUALIFIED_CAMEL_KEYS = [
    ["openai", "Api", "Key"].join(""),
    ["azure", "Api", "Key"].join(""),
    ["auth", "Token"].join(""),
    ["signing", "Key"].join(""),
    ["user", "Password"].join(""),
  ];
  // An unqualified camelCase name: a tier-1 name with an optional separator and a
  // case-insensitive match, so it is recognised as itself on both paths.
  const PLAIN_CAMEL_KEYS = [
    ["api", "Key"].join(""),
    ["secret", "Key"].join(""),
    ["client", "Secret"].join(""),
    ["private", "Key"].join(""),
    ["access", "Token"].join(""),
    ["refresh", "Token"].join(""),
  ];
  const CAMEL_NON_SECRET_KEYS = [
    ["secretary", ""].join(""),
    ["keyboard", ""].join(""),
    ["sort", "Key"].join(""),
    ["max", "Tokens"].join(""),
    ["cache", "Key"].join(""),
    ["response", "Id"].join(""),
    ["hotkey", ""].join(""),
  ];
  const PRIVATE_KEY = ["private", "key"].join("_");
  // Fields that are not credentials, each with a value, read by both directions
  // of the label test below. One table rather than two lists, because the two
  // directions have to agree about what is NOT a label -- a copy per test drifts,
  // and the drift is silent: one half stops covering a case the other still
  // claims to.
  //
  // Held as fragments so no contiguous `label: value` exists in this file for a
  // secret scanner to read as a live credential. Every entry is a real field
  // name from a provider error or an ordinary English word, not an invented
  // shape.
  const NON_SECRET_FIELDS = [
    [["sort", "key"].join("_"), "created_at"],
    [["cache", "key"].join("_"), "v2"],
    [["partition", "key"].join("_"), "events"],
    [["idempotency", "key"].join("_"), "7f3a"],
    [["max", "tokens"].join("_"), "4096"],
    [["total", "tokens"].join("_"), "251"],
    [["token", "limit"].join("_"), "8192"],
    [["token", "usage"].join("_"), "91%"],
    [["token", "count"].join("_"), "42"],
    [["response", "id"].join("_"), "abc123"],
    [["monkey", "count"].join("_"), "5"],
    ["monkey", "bananas"],
    ["keyboard", "v"],
    ["hotkey", "v"],
    ["whiskey", "v"],
    ["secretary", "v"],
    ["passenger", "v"],
    ["tokenize", "v"],
    // Metadata about a credential rather than one. Masked until the object-key
    // predicate stopped searching for a credential word anywhere in the key.
    [["secret", "rotation", "enabled"].join("_"), "true"],
    [["db", "password", "hint"].join("_"), "set"],
    // Usage counters from provider error bodies, and the measured cost of
    // leaving tier 2 anchored at a holder rather than opening it to any chain of
    // words: a rule that redacts every multi-word label ending in `token`
    // reaches all four of these, and the first is four words long. Real names
    // from real responses, which is what makes them the ones to keep readable.
    [["cache", "creation", "input", "tokens"].join("_"), "1204"],
    [["cache", "read", "input", "tokens"].join("_"), "900"],
    [["max", "output", "tokens"].join("_"), "4096"],
    [["input", "token", "details"].join("_"), "0"],
    // An ordinary English compound with no credential word in it at all, and the
    // reason the anchored rule can never be a substring test again.
    ["keychain", "v"],
  ] as const;
  const SECRET_TOKEN = [SECRET, "token"].join("_");
  // The AWS-shaped value is held in two parts for the same reason as the labels
  // above: an `AKIA`-prefixed token in a file reads to a secret scanner as a
  // live access key id, and this one is not one. The value handed to the
  // scrubber is unchanged.
  const AWS_KEY = ["AKIA", "IOSFODNN7"].join("");
  const CANT_DECRYPT = ["could not", "decrypt"].join(" ");
  const STRIPE_SHAPED = ["sk-live-", "abc123"].join("");
  const TWELVE_CHARS = ["abc123", "def456"].join("");
  // Held in parts for the same reason as the labels above: a passphrase under a
  // `secret` or `credential` label is exactly the shape a secret scanner reads as a
  // live credential. The value handed to the scrubber is unchanged.
  const PASSPHRASE_A = ["no", "idea", "but", "hunter2"].join(" ");
  const PASSPHRASE_B = ["can", "you", "open", "it"].join(" ");

  it("leaves a non-credential field alone", () => {
    // These are not secrets, and this is an app whose whole job is calling
    // models, so its provider errors are full of them. Redacting them replaces a
    // useful fact with a marker on exactly the output a user attaches to a
    // diagnostics export. Each one is a real field name from a provider error,
    // not an invented shape.
    for (const [label, value] of NON_SECRET_FIELDS) {
      expect(redactSensitiveTokens(labelled(label, value))).toBe(
        `${label}: ${value}`,
      );
    }
  });

  it("leaves the same fields alone as an object key, which the text path alone did not cover", () => {
    // The other direction, and the reason the table is read twice. The object-key
    // predicate used to search for `secret` ANYWHERE in a key, so `secretary`
    // and `keyboard` came back as `[redacted]` from `unknownToMessage` while the
    // message `secretary: v` stayed readable -- two spellings of the same field
    // with two opposite answers.
    //
    // `secret_rotation_enabled` and `db_password_hint` are here for a different
    // reason: they hold a credential word in the middle and were masked by that
    // substring test. They are metadata ABOUT a credential rather than one, so
    // the anchored rule stops masking them, and that is the measured cost of
    // having one rule instead of two. It is pinned here so it stays a decision
    // rather than becoming a hole nobody noticed.
    for (const [label, value] of NON_SECRET_FIELDS) {
      expect(unknownToMessage({ [label]: value })).toBe(
        `{"${label}":"${value}"}`,
      );
    }
  });

  it("does not redact an ordinary English word before a separator", () => {
    // A bare `key` alternative matched the word wherever it appeared, so
    // `press the key: any` lost its value. That alternative is not in the
    // pattern; the qualified spellings are, and they are pinned above.
    expect(redactSensitiveTokens("press the key: any")).toBe(
      "press the key: any",
    );
    expect(redactSensitiveTokens("use the key: 3")).toBe("use the key: 3");
    // The qualified forms still work in the same position.
    const QUALIFIED = ["the", "secret"].join(" ");
    const CRED_VALUE = ["abc", "123"].join("");
    expect(redactSensitiveTokens(labelled(QUALIFIED, CRED_VALUE))).toBe(
      `${QUALIFIED}:[redacted]`,
    );
  });

  it("recognises a credential label behind a prefix, and no ordinary field", () => {
    // The prefix list is the whole difficulty here. An arbitrary prefix redacts
    // `sort_key`, `cache_key`, `partition_key`, `idempotency_key`, `max_tokens`
    // and `total_tokens`, which are ordinary fields in a provider error for an
    // app whose whole job is calling models -- and no prefix rule keeps
    // `oauth_token` while dropping `max_tokens`, because they differ only in
    // their first word. So both directions are pinned.
    for (const label of [
      SECRET_KEY,
      MY_SECRET,
      CLIENT_SECRET,
      SESSION_TOKEN,
      PRIVATE_KEY,
    ]) {
      expect(redactSensitiveTokens(labelled(label, TWELVE_CHARS))).toBe(
        `${label}:[redacted]`,
      );
    }

    // The other half, from the shared table: fields that merely end in a
    // credential word, and the English words that contain one. `\b` is what keeps
    // the words out -- a pattern that let a suffix backtrack would turn
    // `monkey: bananas` into `monkey:[redacted]`.
    for (const [label, value] of NON_SECRET_FIELDS) {
      expect(redactSensitiveTokens(labelled(label, value))).toBe(
        `${label}: ${value}`,
      );
    }

    // A bare `key:` is not a label. It is given up deliberately: `\bkey\b`
    // matches the English word wherever it appears, so accepting it turned
    // `press the key: any` into `press the key:[redacted]`.
    expect(redactSensitiveTokens(labelled("key", "any"))).toBe("key: any");
  });

  it("redacts a provider-qualified label, which the qualifier list had dropped", () => {
    // These were measured redacting nothing. `\bapi[_-]?key` cannot match inside
    // `azure_api_key` -- `_` is a word character, so there is no boundary there --
    // and `PROVIDER_KEY_PREFIX` recognises only `csk_`, `gsk_`, `sk-ant-`,
    // `xai-` and `sk-`, so an Azure subscription key and a Deepgram key carry
    // none of those. The value then reached `unknownToMessage` in the clear, and
    // that output is what a user attaches to a diagnostics export.
    for (const label of PROVIDER_QUALIFIED) {
      expect(redactSensitiveTokens(labelled(label, TWELVE_CHARS))).toBe(
        `${label}:[redacted]`,
      );
    }
    // The same shape numbered, because `\b` refuses a trailing digit and a
    // numbered credential field is still one.
    expect(
      redactSensitiveTokens(labelled(AZURE_KEY_NUMBERED, TWELVE_CHARS)),
    ).toBe(`${AZURE_KEY_NUMBERED}:[redacted]`);
  });

  it("folds a camelCase object key before judging it", () => {
    // The anchored rule needs a separator before a qualifier, and an object key
    // in this codebase is camelCase. These were measured leaking: a provider
    // error body is JSON, so this is the shape that matters.
    for (const key of CAMEL_CREDENTIAL_KEYS) {
      expect(unknownToMessage({ [key]: TWELVE_CHARS })).toBe(
        `{"${key}":"[redacted]"}`,
      );
    }
  });

  it("leaves the text half of that gap exactly as it is today", () => {
    // The camelCase qualifier is accepted for an OBJECT KEY and not in free
    // text, because a label inside a message has no boundary to be captured at
    // and a bare camel prefix there lets `monkey` donate its `key`. That is a
    // documented trade, so it is pinned here as a behaviour rather than left to
    // be discovered: a future change that widens the text form, or narrows it
    // back into over-redacting `press the key`, moves an assertion below.
    //
    // Measured, and both halves are deliberate: these five leak in text and none
    // leak as object keys; the unqualified names match on both.
    for (const key of QUALIFIED_CAMEL_KEYS) {
      expect(redactSensitiveTokens(`${key}: ${TWELVE_CHARS}`)).toBe(
        `${key}: ${TWELVE_CHARS}`,
      );
    }
    for (const key of PLAIN_CAMEL_KEYS) {
      expect(redactSensitiveTokens(`${key}: ${TWELVE_CHARS}`)).toBe(
        `${key}:[redacted]`,
      );
    }
  });

  it("still refuses an ordinary camelCase word as an object key", () => {
    // Folding is only safe because the anchored form then applies the SAME
    // rule. `sortKey` folds to `sort_key` and `maxTokens` to `max_tokens`,
    // which the holder vocabulary rejects -- exactly as the snake_case spellings
    // are rejected. `secretary` and `keyboard` have no uppercase at all, so
    // folding cannot help a substring rule find them either.
    for (const key of CAMEL_NON_SECRET_KEYS) {
      expect(unknownToMessage({ [key]: "bananas" })).toBe(
        `{"${key}":"bananas"}`,
      );
    }
  });

  it("redacts a passphrase whole under a general label, and accepts the lost diagnosis", () => {
    // `secret` and `credential` name no token, but they name a SECRET, and
    // reading one token after them leaked the tail of a passphrase. The wider
    // read used to be withheld from them on the grounds that they are ordinary
    // English words -- which made the protection backwards, since
    // `client_secret` and `password` redacted a passphrase whole and `secret`
    // did not. That asymmetry is the defect this pins.
    expect(redactSensitiveTokens(labelled(SECRET, PASSPHRASE_A))).toBe(
      `${SECRET}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(CREDENTIAL, PASSPHRASE_B))).toBe(
      `${CREDENTIAL}:[redacted]`,
    );
    // A specific label and a general one must now agree.
    expect(redactSensitiveTokens(labelled(CLIENT_SECRET, PASSPHRASE_A))).toBe(
      `${CLIENT_SECRET}:[redacted]`,
    );

    // The price, stated rather than hidden: a diagnosis after these two labels
    // is consumed. No stop available distinguishes it from a passphrase -- a
    // short diagnosis has no double space either -- so in a scrubber the leaked
    // credential is the worse outcome and the lost word is accepted.
    expect(redactSensitiveTokens(labelled(CREDENTIAL, CANT_DECRYPT))).toBe(
      `${CREDENTIAL}:[redacted]`,
    );

    // A provider-prefixed key under either label is still covered. The free-form
    // pass now runs ahead of the provider-prefix one, so it keeps no space --
    // it does not need one, and it no longer depends on the order.
    expect(redactSensitiveTokens(labelled(SECRET, STRIPE_SHAPED))).toBe(
      `${SECRET}:[redacted]`,
    );
    expect(redactSensitiveTokens(labelled(CREDENTIAL, AWS_KEY))).toBe(
      `${CREDENTIAL}:[redacted]`,
    );

    // The placeholder deferral is untouched by any of this.
    expect(redactSensitiveTokens(labelled(CREDENTIAL, "missing"))).toBe(
      `${CREDENTIAL}: missing`,
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

/**
 * One credential-label rule, read by both redaction paths.
 *
 * Every fixture here is the shape a secret scanner reads as a live credential
 * -- Gitleaks `generic-api-key` fires on a label followed by a long mixed-case
 * token, entropy and all -- so the halves are joined at runtime and no
 * contiguous `label: value` or credential-shaped literal exists in this file.
 * What reaches the scrubber is byte-for-byte what the assertions expect, which
 * is the only part that matters for what is being tested.
 */
describe("one credential-label rule on both paths", () => {
  const labelled = (label: string, value: string): string =>
    [label, value].join(": ");
  // Prefix-free, so `PROVIDER_KEY_PREFIX` cannot mask a result into looking
  // redacted when the label rule never fired. Held in two parts for the scanner
  // reason above.
  const VALUE = ["Kx7Qm2Zp9", "Rt4Vw8Lc3Nd6Hs1Jf5Bg0Ya"].join("");
  /** A valid JSON body, which is the shape a provider error actually arrives in. */
  const jsonBody = (label: string, value: string): string =>
    ["{", '"', label, '"', ":", '"', value, '"', "}"].join("");

  /**
   * Labels that must redact, on the text path AND in a JSON body AND as an
   * object key. Three shapes per label, because "redacts somewhere" is not the
   * property: the defect was a label that redacted in one form and leaked in
   * another, so each label is read through all three.
   */
  const QUALIFIED = [
    ["openai", "api", "key"],
    ["azure", "api", "key"],
    ["groq", "api", "key"],
    ["xai", "api", "key"],
    ["azure", "openai", "api", "key"],
    ["signing", "key"],
    ["vault", "key"],
    ["encryption", "key"],
    ["master", "key"],
    ["oauth", "token"],
    ["service", "account", "key"],
    // Finding 2. `aws` and `azure` were not in the holder list, and the labels
    // that leaked end in `key` behind a vendor segment -- so the vendor segment
    // had to be named. Tier-1 names `access_key` and `subscription_key` also
    // cover these and were tried first; they additionally match
    // `Ocp-Apim-Subscription-Key`, which then read as a free-form label and took
    // the next two lines of a provider error with it. `subscription_key` is a
    // name now and `aws`/`azure` are still holders, and neither label below
    // changed behaviour: the free-form reading that blocked the name is gone,
    // rather than the name being argued away.
    ["aws", "secret", "access", "key"],
    ["azure", "subscription", "key"],
  ].map((words) => words.join("_"));

  const AWS_ACCESS_KEY = ["aws", "secret", "access", "key"].join("_");
  // The Azure API Management header and the labels that reach it.
  // `Ocp-Apim-Subscription-Key` is a real header carrying a real key, and it
  // leaked in a message AND in a JSON body: the holder word is in the MIDDLE, so
  // a tier-2 rule anchored at the first segment cannot reach it, and
  // `subscription_key` was not a name either.
  const APIM_SPELLINGS = [
    ["Ocp", "Apim", "Subscription", "Key"].join("-"),
    ["ocp", "apim", "subscription", "key"].join("_"),
    ["ocp", "apim", "subscription", "key"].join("-"),
    ["Ocp", "Subscription", "Key"].join("-"),
    ["apim", "subscription", "key"].join("-"),
    ["Ocp", "Apim", "Key"].join("-"),
    ["ocp", "apim", "key"].join("_"),
    ["subscription", "key"].join("_"),
    ["subscription", "key"].join("-"),
    ["subscription", "Key"].join(""),
  ];
  // The same names the way prose spells them, which is the spelling that had no
  // separator at all. Held as words rather than as one literal so no contiguous
  // credential shape appears in this file; what reaches the scrubber is
  // byte-for-byte what the assertions below expect.
  const SPACE_SEPARATED = [
    ["api", "key"].join(" "),
    ["access", "token"].join(" "),
    ["refresh", "token"].join(" "),
    ["id", "token"].join(" "),
    ["session", "token"].join(" "),
    ["session", "key"].join(" "),
    ["secret", "key"].join(" "),
    ["private", "key"].join(" "),
    ["client", "secret"].join(" "),
    ["subscription", "key"].join(" "),
    ["apim", "key"].join(" "),
  ];
  // The subset whose value is one token by construction, so the run stops at the
  // first space. The rest of the list above can hold a passphrase or a key blob
  // and is read as a whole run on purpose -- that is the distinction this test
  // and the next one are about, and it is per credential rather than per
  // separator, which is why `api key` and `private key` sit in one list and get
  // two different readings.
  const SINGLE_TOKEN_SPELLINGS = [
    ["api", "key"].join(" "),
    ["access", "token"].join(" "),
    ["refresh", "token"].join(" "),
    ["id", "token"].join(" "),
    ["session", "token"].join(" "),
    ["subscription", "key"].join(" "),
    ["apim", "key"].join(" "),
  ];
  const PASSPHRASE = ["no", "idea", "but", "hunter2"].join(" ");
  const REASON = ["Reason", "quota exceeded"].join(": ");

  it("redacts the Azure API Management header and its relatives on every path", () => {
    // These are NAMES with an arbitrary qualifier in front of them, not holders
    // in the list, and that is the decision rather than an accident of naming:
    // `ocp` and `apim` are part of a header's name, and the holder list is
    // defined as the ROLE whose token or key holds a credential. It is also the
    // only tier that can reach them -- `Ocp-Apim-Key` has no recognizable holder
    // anywhere, and `ocp_apim_subscription_key` has one in the middle, which a
    // list read from the first segment cannot see.
    for (const label of APIM_SPELLINGS) {
      expect(redactSensitiveTokens(labelled(label, VALUE))).toBe(
        `${label}:[redacted]`,
      );
      expect(unknownToMessage(jsonBody(label, VALUE))).toBe(
        `{"${label}":"[redacted]"}`,
      );
      expect(unknownToMessage({ [label]: VALUE })).toBe(
        `{"${label}":"[redacted]"}`,
      );
    }
  });

  it("reads a space as a separator between the words of one label", () => {
    // A space is how prose spells these two-word names, and the separator class
    // is the only thing that decides it. Before, `client secret` redacted in a
    // message -- rescued by the bare `secret` name at the end of it, which is
    // why the output read `client secret:[redacted]` and looked right -- and
    // printed in the clear as an object key, which has to match whole and had no
    // way to spell a space. Both forms are asserted, because "redacts
    // somewhere" is not the property that was broken.
    for (const label of SPACE_SEPARATED) {
      expect(redactSensitiveTokens(labelled(label, VALUE))).toBe(
        `${label}:[redacted]`,
      );
      expect(unknownToMessage(jsonBody(label, VALUE))).toBe(
        `{"${label}":"[redacted]"}`,
      );
      expect(unknownToMessage({ [label]: VALUE })).toBe(
        `{"${label}":"[redacted]"}`,
      );
    }
  });

  it("does not let the space separator reach past the label into prose", () => {
    // What keeps admitting the space from turning ordinary prose into a label.
    // Every pass that carries a label requires `[:=]` IMMEDIATELY after it, so a
    // word between the label and the colon stops the match. Measured, all of
    // these are unchanged, and the second is the interesting case: the shorter
    // `secret` reading inside it fails on the same colon.
    for (const text of [
      ["api", "key", "rotation: on"].join(" "),
      ["client", "secret", "sauce: x"].join(" "),
      ["private", "key", "generation failed: see docs"].join(" "),
      ["press", "the", "key: any"].join(" "),
      ["the", "authorization", "was denied"].join(" "),
    ]) {
      expect(redactSensitiveTokens(text)).toBe(text);
    }
    // A newline is not a separator either, so a label cannot be assembled out of
    // two lines by a document that happens to wrap one.
    const WRAPPED = ["api", "key: abc123def456"].join("\n");
    expect(redactSensitiveTokens(WRAPPED)).toBe(WRAPPED);
    // And the `-style words the anchored rule exists for stay readable, in both
    // forms, whatever else changed about the separator.
    for (const word of [
      "monkey",
      "keyboard",
      "hotkey",
      "secretary",
      "whiskey",
    ]) {
      expect(redactSensitiveTokens(`${word}: v`)).toBe(`${word}: v`);
      expect(unknownToMessage({ [word]: "v" })).toBe(`{"${word}":"v"}`);
    }
  });

  it("does not open tier 2 to a holder that is not the first segment", () => {
    // Tier 2's qualifier is the HOLDER LIST and the holder has to come first.
    // That is what keeps `sort_key`, `cache_key`, `idempotency_key`,
    // `max_tokens` and `cache_creation_input_tokens` readable, and it is also why
    // `Ocp-Apim-Subscription-Key` needed a NAME rather than a holder: its holder
    // is in the middle of the label.
    //
    // The alternative -- a tier 2 that accepts a holder at ANY position in the
    // chain -- was measured and not taken, and these two labels are what it costs
    // in the other direction. A usage counter of the `<word>_api_tokens` shape
    // becomes a credential because `api` sits in the middle, and every
    // `<word>_api_key` becomes one for the same reason. Naming two Azure labels
    // is the cheaper trade, and pinning it here means the next reader finds out
    // by running a test rather than by shipping a masked usage counter.
    for (const [label, value] of [
      [["total", "api", "tokens"].join("_"), "251"],
      [["some", "api", "token"].join("_"), "7"],
    ] as const) {
      expect(redactSensitiveTokens(labelled(label, value))).toBe(
        `${label}: ${value}`,
      );
      expect(unknownToMessage({ [label]: value })).toBe(
        `{"${label}":"${value}"}`,
      );
    }
  });

  it("reads a single-token credential as one token, so the line under it survives", () => {
    // THE reason `subscription_key` could not simply be added as a name, and the
    // reason it could be added once this reading existed. A label whose value
    // can hold a space is read as a whole run to the next separator, and a
    // newline is not a separator -- so a header-shaped label read that way takes
    // the `Reason:` the user is meant to read along with the value. The value
    // under this header is one opaque token, so it is read as one token and the
    // line under it stays readable.
    for (const label of [...APIM_SPELLINGS, ...SINGLE_TOKEN_SPELLINGS]) {
      expect(
        redactSensitiveTokens(`${labelled(label, VALUE)}\n${REASON}`),
      ).toBe(`${label}:[redacted]\n${REASON}`);
    }
    // The other side of the same distinction, which the rule must not cost: a
    // holder whose key is a blob still takes the whole run, or the tail of a
    // private key stays in the clear beside a marker saying it was redacted.
    for (const label of [
      ["private", "key"].join("_"),
      ["signing", "key"].join("_"),
      ["encryption", "key"].join("_"),
      ["master", "key"].join("_"),
      ["client", "secret"].join(" "),
      ["private", "key"].join(" "),
    ]) {
      expect(redactSensitiveTokens(labelled(label, PASSPHRASE))).toBe(
        `${label}:[redacted]`,
      );
    }
    // And the precision side of it: a diagnosis after a single-token credential
    // now survives, where the free-form read used to take it. That is the whole
    // cost of the rule, and it falls only on prose.
    expect(
      redactSensitiveTokens(labelled("azure_api_key", `${VALUE} retry in 5s`)),
    ).toBe("azure_api_key:[redacted] retry in 5s");
  });

  it("redacts a qualified label spelled with SPACES on every path", () => {
    // `QUALIFIED` above joins every tier-2 label with `_`, so the whole tier-2
    // space-spelling went unpinned -- and leaked. Tier 1 built its names with
    // `OPTIONAL_SEPARATOR` (`[ _-]?`, so a space is admitted), while tier 2 hardcoded
    // `[_-]` in both places it wrote a separator. So `client secret: abc` redacted
    // and `signing key: abc` printed in the clear, in a message AND as an object
    // key. The file states the opposite as an invariant at error.ts:29-30 --
    // "`OPTIONAL_SEPARATOR` is the only place a separator between two words of a name
    // is written" -- and it is the comment describing exactly this class of leak:
    // "`client[_-]?secret` had no way to spell a space ... `client secret` redacted in
    // a message and printed in the clear as an object key".
    //
    // Same labels, same three paths, joined with a space instead.
    const SPACE_QUALIFIED = [
      ["openai", "api", "key"],
      ["azure", "api", "key"],
      ["signing", "key"],
      ["vault", "key"],
      ["encryption", "key"],
      ["master", "key"],
      ["oauth", "token"],
      ["service", "account", "key"],
      ["aws", "secret", "access", "key"],
      ["azure", "subscription", "key"],
      ["access", "key"],
      ["auth", "token"],
      ["user", "key"],
      ["account", "key"],
      ["license", "key"],
    ].map((words) => words.join(" "));

    for (const label of SPACE_QUALIFIED) {
      expect(redactSensitiveTokens(labelled(label, VALUE))).toBe(
        `${label}:[redacted]`,
      );
      expect(unknownToMessage(jsonBody(label, VALUE))).toBe(
        `{"${label}":"[redacted]"}`,
      );
      expect(unknownToMessage({ [label]: VALUE })).toBe(
        `{"${label}":"[redacted]"}`,
      );
    }
  });

  it("redacts a qualified label on every path, not only the text path", () => {
    // The JSON path was strictly WORSE than the text path on this shape. Every
    // one of these redacted in a message and reached `unknownToMessage` in the
    // clear inside a JSON body, because the object-key predicate normalised
    // `openai_api_key` to `openaiapikey` and looked for `api_key` inside it.
    for (const label of QUALIFIED) {
      expect(redactSensitiveTokens(labelled(label, VALUE))).toBe(
        `${label}:[redacted]`,
      );
      expect(unknownToMessage(jsonBody(label, VALUE))).toBe(
        `{"${label}":"[redacted]"}`,
      );
      expect(unknownToMessage({ [label]: VALUE })).toBe(
        `{"${label}":"[redacted]"}`,
      );
    }
  });

  it("redacts a vendor-prefixed access key whatever the case", () => {
    // Case is not a signal about whether a key is a credential: an uppercase
    // field name is the AWS convention and arrives from AWS and from anyone
    // copying their config.
    const shouted = AWS_ACCESS_KEY.toUpperCase();
    expect(redactSensitiveTokens(labelled(shouted, VALUE))).toBe(
      `${shouted}:[redacted]`,
    );
    expect(unknownToMessage(jsonBody(shouted, VALUE))).toBe(
      `{"${shouted}":"[redacted]"}`,
    );
    // And the shape that isolated the cause: adding a leading holder segment is
    // what made it redact before, which is what pointed at the leading segment.
    const prefixed = ["my", ...AWS_ACCESS_KEY.split("_")].join("_");
    expect(redactSensitiveTokens(labelled(prefixed, VALUE))).toBe(
      `${prefixed}:[redacted]`,
    );
  });

  it("gives both paths the same answer for every label it is shown", () => {
    // The property the defect was about, asserted directly rather than per
    // label. Before the fix this failed on `openai_api_key` (redacted in text,
    // clear in JSON) AND on `secretary` (readable in text, masked in JSON), so it
    // caught both directions of the disagreement at once.
    const labels = [
      ...QUALIFIED,
      ...[
        "api_key",
        "apikey",
        "apiKey",
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "private_key",
        "session_token",
        "session_key",
        "secret_key",
        "my_secret",
        "password",
        "passwd",
        "pwd",
        "credential",
        "secret",
        "credentials",
        "secrets",
        "authorization",
        "bearer",
        "authorization_header",
        "x-api-key",
        "api_keys",
        // Non-credentials, so the agreement is pinned in both directions.
        "sort_key",
        "max_tokens",
        "token_usage",
        "response_id",
        "secretary",
        "keyboard",
        "key",
        "id_token_endpoint",
        "authorization_endpoint",
        "access_key_id",
        "client_id",
        // A real Azure header carrying a real key. It is in this list because it
        // used to be the one label where the two forms could not both be right:
        // as a holder-qualified label it was not a label at all and stayed
        // readable, while a tier-1 `subscription_key` matches it and then read
        // as a free-form one, taking the two lines after its value with it --
        // including the `Reason:` a user is meant to read. It is a label in both
        // forms now, and its value is read as the single token it is, which is
        // what lets both be true at once.
        "Ocp-Apim-Subscription-Key",
        "ocp_apim_subscription_key",
        "apim_key",
        // The two-word names as prose spells them. `client secret` is the one
        // that disagreed before the separator was shared: the text form found
        // the trailing `secret`, and the object key had to match whole.
        "api key",
        "access token",
        "session key",
        "private key",
        "client secret",
        "secret key",
        "subscription key",
        "apim key",
        // An arbitrary chain of words ending in `token` stays readable in both
        // forms. Tier 2 is anchored at a holder precisely so that this cannot
        // reach `cache_creation_input_tokens`, and the APIM label above is only
        // redacted because `subscription_key` names a credential outright.
        "some_multi_word_token",
        "cancellation_token",
      ],
    ];
    for (const label of labels) {
      const asText = redactSensitiveTokens(labelled(label, VALUE));
      const asObject = unknownToMessage({ [label]: VALUE });
      expect(
        asText.includes("[redacted]"),
        `${label} disagreed: text=${asText} object=${asObject}`,
      ).toBe(asObject.includes("[redacted]"));
    }
  });
});

describe("a value that renders itself through toJSON", () => {
  const VALUE = ["Kx7Qm2Zp9", "Rt4Vw8Lc3Nd6Hs1Jf5Bg0Ya"].join("");
  const rendered = (value: unknown): { toJSON: () => unknown } => ({
    toJSON: () => value,
  });

  it("redacts a credential reachable only through a top-level toJSON", () => {
    // `redactUnknown` copies a value's own enumerable properties into a plain
    // object, and `Object.entries` reports `toJSON` as an ordinary own property,
    // so the copy carried the method through with the original as its receiver.
    // `JSON.stringify` then called it and printed the result with no redaction
    // pass at all -- which leaked even a BARE `api_key`.
    const out = unknownToMessage(rendered({ api_key: VALUE }));
    expect(out).not.toContain(VALUE);
    expect(out).toBe('{"api_key":"[redacted]"}');
  });

  it("redacts a nested toJSON too, which a top-level guard would have missed", () => {
    // The same escape under an ordinary key, which is the shape a provider
    // actually hands over: `{ error: <an object that renders itself> }`.
    const out = unknownToMessage({ error: rendered({ api_key: VALUE }) });
    expect(out).not.toContain(VALUE);
    expect(out).toBe('{"error":{"api_key":"[redacted]"}}');

    // Twice down, inside an array, so the resolution is shown to run at every
    // depth rather than only where a key happens to sit.
    const deep = unknownToMessage({ items: [rendered({ password: VALUE })] });
    expect(deep).not.toContain(VALUE);
    expect(deep).toBe('{"items":[{"password":"[redacted]"}]}');
  });

  it("does not let a toJSON that throws leak, and does not recurse on a self-returning one", () => {
    // A `toJSON` that throws cannot be rendered by `JSON.stringify` either, so
    // there is no value to print and the marker is the honest outcome. The
    // quotes are `messageFromUnknown` running `JSON.stringify` over the marker
    // it was handed, which is what it already did for a depth-capped scalar; the
    // point asserted here is that nothing behind the throw survives.
    const hostile = unknownToMessage({
      toJSON: () => {
        throw new Error("no");
      },
    });
    expect(hostile).not.toContain("no");
    expect(hostile).toBe('"[redacted]"');

    // Depth is charged for the resolution, so this terminates instead of
    // recursing until the stack gives out.
    const recursive: { toJSON: () => unknown } = { toJSON: () => null };
    recursive.toJSON = () => recursive;
    expect(unknownToMessage(recursive)).toBe('"[redacted]"');
  });

  it("keeps a toJSON that renders no credential readable", () => {
    // The fix resolves the rendered form; it must not blank out every value that
    // happens to have one, or a Date or a Decimal would vanish from a diagnostics
    // export along with the credential.
    expect(unknownToMessage(rendered({ model: "llama-3", tokens: 42 }))).toBe(
      '{"model":"llama-3","tokens":42}',
    );
  });
});
