import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  azureTestIntegration,
  azureTranscribeAudio,
  buildSilentProbeWav,
  writeWavChunkId,
} from "./azure.utils";

// The Azure SDK is mocked at module level: azureTranscribeAudio wires real
// recognizer objects, so the test only needs fromSubscription/fromRecognizer
// shims plus a recognizer that resolves immediately.
const capturedPhrases: string[] = vi.hoisted(() => []);
// What the mocked recognizer reports back, so the credential probe can be
// driven through a completed recognition, a completed NoMatch, an
// unrecognised result, and a rejected one.
const speech = vi.hoisted(() => ({
  error: null as string | null,
  result: { reason: "recognized", text: "hello world" } as {
    reason: string;
    text?: string;
    errorDetails?: string;
  },
  subscriptions: [] as string[][],
  formats: [] as unknown[][],
  calls: 0,
}));
/** Where the probe's own log lines land, so a test can read them. */
const consoleError = vi.hoisted(() => vi.fn());

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: {
    // The real SDK runs Contracts.throwIfNullOrWhitespace on the key first, so
    // a blank one never reaches the recognizer at all.
    fromSubscription: (key: string, region: string) => {
      speech.subscriptions.push([key, region]);
      if (key.trim().length < 1) {
        throw new Error("throwIfNullOrWhitespace:subscriptionKey");
      }
      return { speechRecognitionLanguage: "" };
    },
  },
  AudioStreamFormat: {
    getWaveFormatPCM: (
      sampleRate: number,
      bitsPerSample: number,
      channels: number,
    ) => {
      speech.formats.push([sampleRate, bitsPerSample, channels]);
      return {};
    },
  },
  AudioInputStream: {
    createPushStream: () => ({
      write: () => undefined,
      close: () => undefined,
    }),
  },
  AudioConfig: {
    fromStreamInput: () => ({}),
  },
  SpeechRecognizer: class {
    recognizeOnceAsync(
      callback: (result: unknown) => void,
      onError: (message: string) => void,
    ) {
      speech.calls += 1;
      if (speech.error !== null) {
        onError(speech.error);
        return;
      }
      callback(speech.result);
    }
    close() {}
  },
  PhraseListGrammar: {
    fromRecognizer: () => ({
      addPhrase: (phrase: string) => capturedPhrases.push(phrase),
    }),
  },
  ResultReason: {
    RecognizedSpeech: "recognized",
    NoMatch: "no-match",
  },
}));

/** Minimal 44-byte WAV header so the SDK parsing path has fields to read. */
const wavBlob = (): ArrayBuffer => {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(24, 16_000, true); // sample rate
  view.setUint16(34, 16, true); // bits per sample
  view.setUint16(22, 1, true); // channels
  return buffer;
};

beforeEach(() => {
  speech.error = null;
  speech.result = { reason: "recognized", text: "hello world" };
  speech.subscriptions = [];
  speech.formats = [];
  speech.calls = 0;
  // The probe logs every failure it raises, which keeps the run readable and
  // lets the message-bound test read what was logged.
  vi.spyOn(console, "error").mockImplementation(consoleError);
});

afterEach(() => {
  vi.restoreAllMocks();
  consoleError.mockClear();
});

describe("azureTranscribeAudio phrase list", () => {
  it("adds each vocabulary phrase to the recognizer, multi-word phrases intact", async () => {
    capturedPhrases.length = 0;
    const output = await azureTranscribeAudio({
      subscriptionKey: "key",
      region: "eastus",
      blob: wavBlob(),
      language: "en",
      phrases: ["Soniya", "Kanye West"],
    });

    expect(output.text).toBe("hello world");
    expect(capturedPhrases).toEqual(["Soniya", "Kanye West"]);
  });

  it("adds no phrases when the vocabulary is empty", async () => {
    capturedPhrases.length = 0;
    await azureTranscribeAudio({
      subscriptionKey: "key",
      region: "eastus",
      blob: wavBlob(),
      language: "en",
      phrases: [],
    });

    expect(capturedPhrases).toEqual([]);
  });
});

describe("azureTestIntegration", () => {
  it("reaches the recognizer with a real WAV header instead of throwing locally", async () => {
    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).resolves.toBe(true);

    // The audio format arguments are read out of the WAV header, so they
    // prove the probe got past the local header parse and reached the
    // recognizer. A 0-byte buffer threw a RangeError here and never made a
    // request.
    expect(speech.formats).toEqual([[16_000, 16, 1]]);
    expect(speech.subscriptions).toEqual([["key", "eastus"]]);
    expect(speech.calls).toBe(1);
  });

  it("builds a canonical 44-byte PCM WAV header for the probe", () => {
    // The probe only proves the key if the service accepts the file, so the
    // chunk ids and every header field are pinned byte for byte.
    const buffer = buildSilentProbeWav();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const readTag = (offset: number) =>
      String.fromCharCode(...Array.from(bytes.slice(offset, offset + 4)));

    expect(buffer.byteLength).toBe(44 + 9_600);
    expect(readTag(0)).toBe("RIFF");
    expect(readTag(8)).toBe("WAVE");
    expect(readTag(12)).toBe("fmt ");
    expect(readTag(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1); // WAVE_FORMAT_PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(9_600); // PCM payload
    // Genuine silence, not a header with noise in it.
    expect(Array.from(bytes.slice(44)).every((byte) => byte === 0)).toBe(true);
  });

  it("treats a completed NoMatch turn as a working credential", async () => {
    // Silence is what the probe sends, and the service answers a NoMatch.
    // That is a completed round trip, so the key works.
    speech.result = { reason: "no-match" };

    await expect(
      azureTranscribeAudio({
        subscriptionKey: "key",
        region: "eastus",
        blob: wavBlob(),
      }),
    ).resolves.toEqual({ text: "" });
    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).resolves.toBe(true);
  });

  it("rejects an unrecognised result rather than reporting a working key", async () => {
    speech.result = {
      reason: "something-new",
      errorDetails: "The audio could not be decoded.",
    };

    await expect(
      azureTranscribeAudio({
        subscriptionKey: "key",
        region: "eastus",
        blob: wavBlob(),
      }),
    ).rejects.toThrow("The audio could not be decoded.");
    // Neither branch of the success/failure boundary may claim a bad key for
    // a turn the service never rejected.
    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not confirm the key/);
  });

  it("reports failure when the service rejects the key", async () => {
    // The service's own 401 body for a credential it will not accept.
    speech.error =
      "Access denied due to invalid subscription key or wrong API endpoint. Path: /speech/recognition.";

    await expect(
      azureTestIntegration({ subscriptionKey: "bad-key", region: "eastus" }),
    ).resolves.toBe(false);
    expect(speech.calls).toBe(1);
  });

  it("reports failure when the handshake rejects the key", async () => {
    // The message the SDK's own ServiceRecognizerBase rejects with, and the
    // only status the SDK offers for a failed handshake.
    speech.error =
      "Unable to contact server. StatusCode: 401, wss://eastus.stt.speech.microsoft.com/speech/recognition Reason: Access denied";

    await expect(
      azureTestIntegration({ subscriptionKey: "bad-key", region: "eastus" }),
    ).resolves.toBe(false);
  });

  it("names the region instead of blaming the key when the region is wrong", async () => {
    // Verbatim from the SDK's own validation table
    // (RestConfigBase.privRestErrors.authInvalidSubscriptionRegion), and the
    // message that used to be read as a success because it mentions neither
    // "authentication" nor "subscription".
    speech.error = "You must specify the Cognitive Speech region to use.";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "westus" }),
    ).rejects.toThrow(/rejected the region "westus"/);
    expect(speech.calls).toBe(1);
  });

  it("names an exhausted quota instead of blaming the key", async () => {
    speech.error =
      "Unable to contact server. StatusCode: 429, wss://eastus.stt.speech.microsoft.com/speech/recognition Reason: Resource has been exhausted (e.g. check quota).";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/no quota left/);
  });

  it("names an unreachable service instead of blaming the key", async () => {
    // The SDK reports 0 when the socket never reached the service.
    speech.error =
      "Unable to contact server. StatusCode: 0, wss://eastus.stt.speech.microsoft.com/speech/recognition Reason: ";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not be reached/);
  });

  it("passes an unrecognised reason through instead of guessing", async () => {
    speech.error = "Something the SDK has never said before.";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/Something the SDK has never said before/);
  });

  it("blames the key when the SDK's own contract check refuses it", async () => {
    // Verbatim from SpeechConfig.fromSubscription, which calls
    // Contracts.throwIfNullOrWhitespace(subscriptionKey, "subscriptionKey")
    // before any request leaves the process. The message names neither
    // "authentication" nor "invalid subscription key", so it used to land in
    // the unknown bucket and lose the credential advice.
    await expect(
      azureTestIntegration({ subscriptionKey: "   ", region: "eastus" }),
    ).resolves.toBe(false);
    // The recognizer is never reached: the SDK refused the key locally.
    expect(speech.calls).toBe(0);
  });

  it("blames the key for the SDK's missing-key message too", async () => {
    // Verbatim from RestConfigBase.privRestErrors.authInvalidSubscriptionKey,
    // the twin of the authInvalidSubscriptionRegion message the region rule
    // reads. Nothing else in the credential list matches it: the words
    // "invalid subscription key" and "access denied" are absent, so this is
    // the only thing keeping the shared /authentication/ rule covered. A
    // pattern naming this message would be dead weight, because every string
    // it matches already contains "authentication".
    speech.error =
      "You must specify either an authentication token to use, or a Cognitive Speech subscription key.";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).resolves.toBe(false);
  });
});

/**
 * The single string the probe handed to the console, or "" if it logged none.
 * Hoisted to module scope so every probe test can assert on what was written
 * rather than each describe keeping its own copy of the capture.
 */
const loggedLine = (): string => {
  // This package targets ES2020, where `Array.prototype.at` is not in the lib,
  // so the last call is taken by index.
  const calls = consoleError.mock.calls;
  const call = calls[calls.length - 1];
  expect(call, "the probe must log the failure it raises").toBeDefined();
  expect(call?.[0]).toBe("Azure integration probe failed:");
  return String(call?.[1] ?? "");
};

describe("azureTestIntegration message bounds", () => {
  /** The message of the failure the probe raised, which is what a user reads. */
  const raisedMessage = async (): Promise<string> => {
    const error = await azureTestIntegration({
      subscriptionKey: "key",
      region: "eastus",
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(
      error,
      "the probe must raise the failure it diagnoses",
    ).toBeDefined();
    return error?.message ?? "";
  };

  /**
   * Credential shapes assembled at runtime, so this repository never holds a
   * literal that matches a provider key pattern, which is what the secret
   * scanner looks for. `azureKeyFixture` is a 32 character hex value shaped like
   * an Azure subscription key, and `jwtFixture` is the three base64url segments
   * of a token.
   */
  const azureKeyFixture = (): string =>
    ["a1b2", "c3d4", "e5f6", "0718", "293a", "4b5c", "6d7e", "8f90"].join("");
  const jwtFixture = (): string =>
    [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
      "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ].join(".");

  it("keeps a handshake rejection out of the snackbar and in the log", async () => {
    // A rejected handshake embeds a full web-services error document, and
    // ApiKeyList hands error.message to showErrorSnackbar, which is a bare
    // String(message). The user gets a diagnosis and a short excerpt; a
    // single-line, capped form of the reason goes to the log.
    const reason = [
      "StatusCode: 500, wss://eastus.stt.speech.microsoft.com/speech/recognition",
      "Reason: WebSocket transport error for incoming WebSocket message:",
      `  {"error":{"code":"500","message":"${"x".repeat(4_000)}"}}`,
    ].join("\n");
    speech.error = reason;

    const message = await raisedMessage();
    expect(message).toMatch(/could not confirm the key/);
    expect(message).toContain("Azure reported:");
    // Bounded, and a snackbar never has to render a paragraph or a line break.
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain("\n");
    // The detail is still available for a bug report, as one log record.
    const logged = loggedLine();
    expect(logged).toContain("StatusCode: 500");
    expect(logged).not.toContain("\n");
    expect(logged.length).toBeLessThan(600);
    // The 4,000 character service body is cut, not copied whole.
    expect(logged).not.toContain("x".repeat(100));
  });

  it("redacts a credential-shaped reason before it reaches the log sink", async () => {
    // The reason is third-party text the probe does not control: a proxy or a
    // gateway can echo the key it forwarded. initLogging hands the webview
    // console to the native log sink, whose rolled file the user attaches to a
    // diagnostics export, and that sink's sanitizer only knows the labels this
    // app writes. So nothing downstream of this line would remove the token.
    // Assembled at runtime so this repository never holds a literal that
    // matches a provider key pattern, which is the same thing the secret
    // scanner looks for.
    const token = ["sk", "proj", "9f2c4a7b1e6d8053ba41c7e9d2f60b84"].join("-");
    speech.error = [
      "Unable to contact server. StatusCode: 403",
      "wss://eastus.stt.speech.microsoft.com/speech/recognition",
      "Reason: upstream rejected the request",
      `Ocp-Apim-Subscription-Key: ${token}`,
      `Authorization: Bearer ${token}`,
    ].join("\n");

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).resolves.toBe(false);

    // A rejected credential returns false without logging, so drive a reason
    // that classifies as a non-credential failure to reach the log line.
    speech.error = [
      "Unable to contact server. StatusCode: 0",
      "wss://eastus.stt.speech.microsoft.com/speech/recognition",
      "Reason: the gateway echoed the credentials it was given",
      `Authorization: Bearer ${token}`,
      `api_key=${token}`,
    ].join("\n");

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not be reached/);

    const logged = loggedLine();
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("Bearer sk-proj-");
    expect(logged).toContain("[redacted]");
    // Still a usable diagnosis.
    expect(logged).toContain("StatusCode: 0");
    expect(logged).not.toContain("\n");
  });

  it("redacts a credential-shaped reason before it reaches the snackbar", async () => {
    // The thrown message is the other half of the exposure the log line is
    // guarded against: ApiKeyList hands error.message to showErrorSnackbar,
    // which is a bare String(message), so the redaction has to run on the text
    // the user reads and not only on the text that is logged. Only the value
    // goes, so the status and the reason survive to tell the user what failed.
    const key = azureKeyFixture();
    speech.error = [
      "StatusCode: 0",
      `Ocp-Apim-Subscription-Key: ${key}`,
      "Reason: the gateway echoed the request",
    ].join("\n");

    const message = await raisedMessage();

    expect(message).not.toContain(key);
    expect(message).toContain("Ocp-Apim-Subscription-Key: [redacted]");
    expect(message).toContain("StatusCode: 0");
    expect(message).toContain("the gateway echoed the request");
    expect(message).toContain("Azure reported:");
    expect(message).toMatch(/could not be reached/);
    expect(message).not.toContain("\n");
  });

  it("redacts a credential named by a quoted JSON label", async () => {
    // An error body or a gateway echo arrives as JSON, where a closing quote
    // sits between the label and the separator, so a pattern that wants the
    // separator directly after the label never matches this shape.
    const key = azureKeyFixture();
    speech.error = `{"ResourceId":"eastus","Ocp-Apim-Subscription-Key":"${key}"}`;

    const message = await raisedMessage();
    const logged = loggedLine();

    for (const text of [message, logged]) {
      expect(text).not.toContain(key);
      expect(text).toContain("Ocp-Apim-Subscription-Key: [redacted]");
      // The rest of the document is the part a support answer is read from.
      expect(text).toContain('"ResourceId":"eastus"');
    }
    expect(message).toMatch(/could not confirm the key/);
  });

  it("redacts a gateway header and a JWT the shared redactor leaves alone", async () => {
    // unknownToMessage in packages/utilities/src/error.ts covers a Bearer
    // token, the labels on its own list (api_key, authorization, credential
    // and the rest) and a provider-prefixed token, which is why the test above
    // passes without this file's redactor. "Ocp-Apim-Subscription-Key" is not
    // one of its labels, a 32 character hex value carries no provider prefix,
    // and a JWT carries no label at all, so all three reach the redactor
    // untouched. Deleting it would put every one of them in the log file the
    // user attaches to a diagnostics export.
    const key = azureKeyFixture();
    const token = jwtFixture();
    speech.error = [
      "Unable to contact server. StatusCode: 0",
      "wss://eastus.stt.speech.microsoft.com/speech/recognition",
      `Ocp-Apim-Subscription-Key: ${key}`,
      `Set-Cookie: auth=${token}`,
    ].join("\n");

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not be reached/);

    const logged = loggedLine();
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(token);
    expect(logged).toContain("Ocp-Apim-Subscription-Key: [redacted]");
    // A token that carries no label is replaced whole, so the marker and the
    // label in front of it are all that is left to read.
    expect(logged).toMatch(/Set-Cookie: auth=\s?\[redacted\]/);
    // Still a usable diagnosis, and one line.
    expect(logged).toContain("StatusCode: 0");
    expect(logged).toContain("wss://eastus.stt.speech.microsoft.com");
    expect(logged).not.toContain("\n");
  });
});

describe("credential redaction is safe on hostile input", () => {
  it("redacts a credential whatever scheme the Authorization header names", async () => {
    // The scheme is not a fixed list, and the credential is what follows it. A
    // pattern that stopped after a scheme word it recognised would leave the
    // credential in the clear for every other scheme, and a scheme can carry
    // parameters of its own.
    //
    // The value is deliberately opaque: shaped like nothing else, so the only
    // thing that can catch it is the authorization pattern. A provider-style
    // token would be redacted by the bare-token rule whatever this pattern did,
    // which would make the test pass either way.
    const credential = "7d41b0c9a3e6f582";
    for (const header of [
      `Authorization: ApiKey ${credential}`,
      `Authorization: Bearer ${credential}`,
      `Authorization: CustomScheme ${credential}`,
      `Authorization: Digest username="u", nonce="${credential}"`,
      `Proxy-Authorization: Negotiate ${credential}`,
      `Authorization: ${credential}`,
    ]) {
      speech.error = `StatusCode: 0\n${header}`;
      await expect(
        azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
      ).rejects.toThrow();

      const written = loggedLine();
      expect(written).toContain("[redacted]");
      expect(written).not.toContain(credential);
      // The label survives, so the line is still a diagnosis.
      expect(written.toLowerCase()).toContain("authorization");
    }
  });

  it("redacts a large reason built to make the patterns work hardest", async () => {
    // The reason is text the remote end chose, so the patterns are bounded
    // rather than trusting it. In production `unknownToMessage` already caps
    // the string at 512 characters before it reaches the redactor, so this is
    // defence in depth. What this pins is that a large hostile-shaped reason is
    // redacted correctly and settles quickly, not that a live backtracking bug
    // was fixed: the earlier unbounded patterns also passed it, because V8
    // handles those without blowing up.
    const hostile = [
      "Ocp-Apim-Subscription-Key" +
        '"'.repeat(20_000) +
        " " +
        ":".repeat(20_000),
      "authorization" + " ".repeat(20_000) + "=" + '"'.repeat(20_000),
      "api_key" + " ".repeat(20_000) + ":" + "sk" + "-a".repeat(20_000),
      "eyJ" +
        "a".repeat(20_000) +
        "." +
        "b".repeat(20_000) +
        "." +
        "c".repeat(20_000),
    ].join(" ");
    expect(hostile.length).toBeGreaterThan(100_000);

    speech.error = `StatusCode: 503\n${hostile}`;
    const started = Date.now();
    // The classification of a 503 is covered elsewhere; what matters here is
    // that the call settles at all, and quickly.
    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Generous enough that a loaded machine cannot fail it, tight enough that an
    // exponential blowup cannot pass it.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("writeWavChunkId", () => {
  it("writes an ASCII chunk id byte for byte", () => {
    const view = new DataView(new ArrayBuffer(4));

    writeWavChunkId(view, 0, "fmt ");

    expect(Array.from(new Uint8Array(view.buffer))).toEqual([
      0x66, 0x6d, 0x74, 0x20,
    ]);
  });

  it("refuses a tag that is not ASCII instead of writing half a surrogate", () => {
    // `for...of` walks code points, so an astral tag arrives whole. Writing
    // its low byte would corrupt the chunk id for every reader of the file,
    // which is what a UTF-16 code unit walk used to do.
    const view = new DataView(new ArrayBuffer(4));
    view.setUint8(0, 0xaa);

    expect(() => writeWavChunkId(view, 0, "😀")).toThrow(RangeError);
    expect(view.getUint8(0)).toBe(0xaa);

    // A non-ASCII code point inside BMP range is refused on the same terms.
    expect(() => writeWavChunkId(view, 0, "é")).toThrow(
      /A WAV chunk id is ASCII/,
    );
  });
});
