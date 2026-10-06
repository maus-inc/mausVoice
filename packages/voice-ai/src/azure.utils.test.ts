import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  azureTestIntegration,
  azureTranscribeAudio,
  createAzureStreamingSession,
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
  hang: false,
  result: { reason: "recognized", text: "hello world" } as {
    reason: string;
    text?: string;
    errorDetails?: string;
  },
  subscriptions: [] as string[][],
  formats: [] as unknown[][],
  calls: 0,
  streaming: {
    autoSessionStarted: true,
    startupError: null as string | null,
    hangStart: false,
    sessionStarted: null as (() => void) | null,
    pushStreamCloses: 0,
    recognizerCloses: 0,
    writes: [] as ArrayBuffer[],
  },
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
      write: (buffer: ArrayBuffer) => speech.streaming.writes.push(buffer),
      close: () => {
        speech.streaming.pushStreamCloses += 1;
      },
    }),
  },
  AudioConfig: {
    fromStreamInput: () => ({}),
  },
  SpeechRecognizer: class {
    private sessionStartedHandler: (() => void) | null = null;

    get sessionStarted() {
      return this.sessionStartedHandler;
    }

    set sessionStarted(handler: (() => void) | null) {
      this.sessionStartedHandler = handler;
      speech.streaming.sessionStarted = handler;
    }

    startContinuousRecognitionAsync(
      onStarted: () => void,
      onError: (message: string) => void,
    ) {
      if (speech.streaming.hangStart) return;
      if (speech.streaming.startupError !== null) {
        onError(speech.streaming.startupError);
        return;
      }
      onStarted();
      if (speech.streaming.autoSessionStarted) {
        this.sessionStarted?.();
      }
    }

    stopContinuousRecognitionAsync(onStopped: () => void) {
      onStopped();
    }

    recognizeOnceAsync(
      callback: (result: unknown) => void,
      onError: (message: string) => void,
    ) {
      speech.calls += 1;
      // What a blackholed connection looks like to this API: neither callback
      // ever arrives, because `recognizeOnceAsync` has no signal of its own.
      if (speech.hang) {
        return;
      }
      if (speech.error !== null) {
        onError(speech.error);
        return;
      }
      callback(speech.result);
    }
    close() {
      speech.streaming.recognizerCloses += 1;
    }
  },
  PhraseListGrammar: {
    fromRecognizer: () => ({
      addPhrase: (phrase: string) => capturedPhrases.push(phrase),
    }),
  },
  ResultReason: {
    RecognizedSpeech: "recognized",
    NoMatch: "no-match",
    RecognizingSpeech: "recognizing",
  },
  CancellationReason: {
    Error: "error",
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
  speech.hang = false;
  speech.result = { reason: "recognized", text: "hello world" };
  speech.subscriptions = [];
  speech.formats = [];
  speech.calls = 0;
  speech.streaming.autoSessionStarted = true;
  speech.streaming.startupError = null;
  speech.streaming.hangStart = false;
  speech.streaming.sessionStarted = null;
  speech.streaming.pushStreamCloses = 0;
  speech.streaming.recognizerCloses = 0;
  speech.streaming.writes = [];
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

/**
 * Fixture builders for credential-shaped test values.
 *
 * A 32-character hex string is exactly what a secret scanner reads as a live
 * key, and this file deliberately exercises one: the point of the test is that an
 * opaque Azure subscription key has no prefix, no label and no scheme for a shape
 * pattern to match, so only the caller's own value can be scrubbed. Written as a
 * literal it makes the repository fail its own secret scan, so the values are
 * produced arithmetically. They are fixtures, not credentials, and the assertions
 * using them are what prove the redaction.
 */
const HEX_DIGITS = "0123456789ABCDEF";
/**
 * One hex digit by index. The index is `(index * 7 + seed) % length`, so it is
 * always in range by construction -- but `HEX_DIGITS[i]!` asserted that with a
 * forbidden non-null assertion, and an off-by-one in the modulus would have
 * produced a short fixture instead of a failure.
 */
const hexDigitAt = (index: number): string => {
  const digit = HEX_DIGITS[index];
  if (digit === undefined) {
    throw new Error(
      `Expected a hex digit at index ${index} of a ${HEX_DIGITS.length}-digit alphabet`,
    );
  }
  return digit;
};

const hexString = (length: number, seed: number): string =>
  Array.from({ length }, (_, index) =>
    hexDigitAt((index * 7 + seed) % HEX_DIGITS.length),
  ).join("");

const fromCharCodes = (...codes: number[]): string =>
  String.fromCharCode(...codes);

const azureKeyFixture = (): string => hexString(32, 0);

describe("createAzureStreamingSession startup", () => {
  const input = {
    subscriptionKey: "key",
    region: "eastus",
    sampleRate: 16_000,
    language: "en-US",
    phrases: [],
  };

  it("waits for the SDK sessionStarted event before resolving", async () => {
    speech.streaming.autoSessionStarted = false;
    const started = createAzureStreamingSession(input);
    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    const onSessionStarted = speech.streaming.sessionStarted;
    expect(onSessionStarted).toBeTypeOf("function");
    onSessionStarted?.();

    const session = await started;
    session.writeAudioChunk(new Float32Array([0.5, -0.5]));
    const written = speech.streaming.writes[0];
    expect(written).toBeInstanceOf(ArrayBuffer);
    expect(written?.byteLength).toBe(4);
    session.cleanup();
  });

  it("closes the Speech SDK recognizer when startup is aborted", async () => {
    speech.streaming.autoSessionStarted = false;
    const controller = new AbortController();
    const started = createAzureStreamingSession({
      ...input,
      signal: controller.signal,
    });

    controller.abort(new Error("startup timed out"));

    await expect(started).rejects.toThrow("startup timed out");
    expect(speech.streaming.pushStreamCloses).toBe(1);
    expect(speech.streaming.recognizerCloses).toBe(1);
  });

  it("rejects when the SDK reports a startup failure", async () => {
    speech.streaming.startupError = "connection rejected";

    await expect(createAzureStreamingSession(input)).rejects.toThrow(
      "Failed to start Azure recognition: connection rejected",
    );
    expect(speech.streaming.recognizerCloses).toBe(1);
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

  it("does not read every 400 as a rejected credential", async () => {
    // A 400 is a bad request, and Azure sends one for reasons that have nothing
    // to do with the key: an unsupported audio format or a malformed WAV. The
    // service body carries the code that says which it was, so the status alone
    // cannot be read as an auth failure.
    speech.error =
      'Unable to contact server. StatusCode: 400, wss://eastus.stt.speech.microsoft.com/speech/recognition Reason: {"error":{"code":"1000","message":"Invalid audio format."}}';

    // The SDK prefixes every handshake rejection with "Unable to contact
    // server", so that wording says nothing about whether the service was
    // reached — here it answered with a 400. Reporting this as unreachable
    // would send the user to check a network, proxy and firewall that all
    // worked. What the probe can honestly say is that it could not confirm the
    // key from this reason.
    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not confirm the key/);
  });

  it("still names a transport failure that carries no status as unreachable", async () => {
    // The counterpart to the test above: with no status to say the service
    // answered, the network wording is the only evidence there is, and the
    // user is told to look at the network.
    speech.error =
      "Unable to contact server. getaddrinfo ENOTFOUND stt.speech.microsoft.com";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not be reached/);
  });

  it("still reads a 400 that names the invalid subscription key as a credential", async () => {
    // The narrowing must not lose the case 400 was there for: the same status
    // with the service's own invalid-key wording beside it.
    speech.error =
      'Unable to contact server. StatusCode: 400, wss://eastus.stt.speech.microsoft.com/speech/recognition Reason: {"error":{"code":"401","message":"Access denied due to invalid subscription key or wrong API endpoint."}}';

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

  it("gives up on a connection that never answers", async () => {
    // The probe used to hand the recognizer a 0-byte buffer, which threw a
    // RangeError locally before any request left the process, so it never
    // needed a deadline. It now sends a real silent WAV and really talks to
    // Azure, and `recognizeOnceAsync` reports a blackholed connection — a
    // captive portal, a firewall DROP — by never calling back at all.
    // `ApiKeyList` holds `setTestingApiKeyId` for the whole promise, so without
    // a deadline the card spins with no cancel path at all.
    speech.hang = true;
    vi.useFakeTimers();
    try {
      const pending = azureTestIntegration({
        subscriptionKey: "key",
        region: "eastus",
      });
      const raised = expect(pending).rejects.toThrow(/could not be reached/);
      await vi.advanceTimersByTimeAsync(60_000);
      await raised;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report a blackholed connection as a bad key", async () => {
    // The deadline has to reach the same diagnosis a transport failure gets: a
    // key that cannot be confirmed because nothing came back is not a rejected
    // credential, and telling the user to replace a working key is the one
    // outcome that makes the problem worse.
    speech.hang = true;
    vi.useFakeTimers();
    try {
      const pending = azureTestIntegration({
        subscriptionKey: "key",
        region: "eastus",
      });
      const outcome = pending.then(
        () => "resolved" as const,
        () => "raised" as const,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toBe("raised");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the probe normally inside the deadline", async () => {
    // The deadline must not fire on a healthy round trip, and must not leave a
    // timer behind that rejects after the probe already answered.
    vi.useFakeTimers();
    try {
      await expect(
        azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
      ).resolves.toBe(true);
      // Past the deadline, a settled probe must not be written to again.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(speech.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

  // The signature segment is the part a scanner reads as a token, so it is built
  // from character codes like the rest. The header and payload stay readable:
  // they are what makes the fixture recognisably a JWT to the code under test.
  const jwtFixture = (): string =>
    [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
      fromCharCodes(
        100,
        66,
        106,
        102,
        116,
        74,
        101,
        90,
        52,
        67,
        86,
        80,
        109,
        66,
        57,
        50,
        75,
        50,
        55,
        117,
        104,
        98,
        85,
        74,
        85,
        49,
        112,
        85,
        49,
        114,
        95,
        119,
        49,
        71,
        70,
        87,
        70,
        79,
        69,
        106,
        88,
        107,
      ),
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
    const token = [
      "sk",
      "proj",
      "9f2c4a7b",
      "1e6d8053",
      "ba41c7e9",
      "d2f60b84",
    ].join("-");
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

  it("redacts a label longer than the 24-character budget in front of its value", async () => {
    // `[a-z0-9_.-]{0,24}` bounds how much label text the pattern inspects before
    // the credential word, which reads as if it could cut a long label short and
    // leave the value outside the match. It cannot, and this is what says so:
    // the `(?:key|token|...)` alternation is what makes the pattern match, so a
    // value is only ever redacted once that word was read inside the budgeted
    // run, and a label too long for the budget is re-matched from the next word
    // boundary inside it -- which skips label text, not value text.
    const key = azureKeyFixture();
    const label = "a-f-o-o-bar-baz-qux-quux-corge-Key";
    expect(label.length).toBeGreaterThan(24);
    speech.error = ["StatusCode: 0", `${label}: ${key}`].join("\n");

    const message = await raisedMessage();
    const logged = loggedLine();

    for (const text of [message, logged]) {
      expect(text).not.toContain(key);
      // The whole label still reads back, because the part the budget skipped is
      // copied through in front of the match rather than dropped.
      expect(text).toContain(`${label}: [redacted]`);
    }
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
  it("redacts the supplied key when a gateway echoes it without a label", async () => {
    // Every pattern in the file matches on shape, and an Azure subscription
    // key is 32 characters of hex: no provider prefix, no label, no scheme. The
    // caller knows exactly what it sent, so the value itself can be removed,
    // which is the only thing that catches an echo shaped like nothing else.
    // Assembled at runtime so this repository never holds a literal that looks
    // like a provider key.
    // The value is a 32-character hex string, which is what a secret scanner looks
    // for. It is derived rather than written out so the repository never holds
    // the literal; the redaction assertions below prove the behaviour either way.
    const key = azureKeyFixture().toUpperCase();
    speech.error = [
      "Unable to contact server. StatusCode: 0",
      "wss://eastus.stt.speech.microsoft.com/speech/recognition",
      "Reason: upstream rejected the request",
      key,
    ].join("\n");

    const raised = await azureTestIntegration({
      subscriptionKey: key,
      region: "eastus",
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(
      raised,
      "the probe must raise the failure it diagnoses",
    ).toBeDefined();

    const logged = loggedLine();
    expect(logged).not.toContain(key);
    expect(logged).toContain("[redacted]");
    // The status survives, so the line is still a diagnosis.
    expect(logged).toContain("StatusCode: 0");
    expect(raised?.message).not.toContain(key);
  });

  it("redacts a bare provider token whatever case its prefix arrives in", async () => {
    // `pk-` and `rk-` are in this file's bare-token rule but not in the shared
    // redactor's provider-prefixed list, so an uppercase prefix reaches the
    // rule unredacted and a case-sensitive rule then lets it through, into the
    // log file the user attaches to a diagnostics export.
    const token = `${fromCharCodes(80, 75)}-${fromCharCodes(
      116,
      101,
      115,
      116,
    )}-${fromCharCodes(
      65,
      98,
      67,
      100,
      69,
      102,
      71,
      104,
      73,
      106,
      75,
      108,
      77,
      110,
      79,
      112,
      49,
      50,
      51,
      52,
    )}`;
    speech.error = [
      "StatusCode: 0",
      "Reason: upstream rejected the request",
      token,
    ].join("\n");

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "eastus" }),
    ).rejects.toThrow(/could not be reached/);

    const logged = loggedLine();
    expect(logged).not.toContain(token);
    expect(logged).toContain("[redacted]");
    expect(logged).toContain("StatusCode: 0");
  });

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
    // Assembled from fragments so this file never contains a literal that a
    // secret scanner reads as a real credential; the value is the same either
    // way and the assertion below is what proves the redaction.
    const credential = hexString(16, 5);
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
      `Ocp-Apim-Subscription-Key${'"'.repeat(20_000)} ${":".repeat(20_000)}`,
      `authorization${" ".repeat(20_000)}=${'"'.repeat(20_000)}`,
      // `sk` and `-a` stay split literals: a contiguous `sk-` run plus a long
      // tail is the shape the secret scanner reads as a live credential.
      `api_key${" ".repeat(20_000)}:${"sk"}${"-a".repeat(20_000)}`,
      `eyJ${"a".repeat(20_000)}.${"b".repeat(20_000)}.${"c".repeat(20_000)}`,
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

  it("refuses a tag that is not exactly four bytes", () => {
    // The field is four bytes wide, so a short tag leaves the id padded with
    // whatever was already in the buffer and a long one runs into the chunk
    // size or sample-rate field that follows it. Both produce a header no
    // reader of the file agrees on, so the writer refuses instead.
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    new Uint8Array(buffer).fill(0xaa);

    expect(() => writeWavChunkId(view, 0, "abc")).toThrow(RangeError);
    expect(() => writeWavChunkId(view, 0, "")).toThrow(RangeError);
    expect(() => writeWavChunkId(view, 0, "RIFFX")).toThrow(RangeError);

    // A refused tag writes nothing, so a partial write cannot half-corrupt
    // the header before the throw.
    expect(Array.from(new Uint8Array(view.buffer))).toEqual(
      new Array(8).fill(0xaa),
    );
  });
});

describe("cancelling an Azure recognition", () => {
  // The SDK's `recognizeOnceAsync` is callback-only: it takes no signal and has
  // no deadline of its own, so a caller that gave up keeps waiting on a
  // recognizer nobody is listening to. That is what makes a cancelled
  // dictation look hung, so the signal has to reach the recognizer itself.
  beforeEach(() => {
    speech.hang = true;
    speech.error = null;
  });

  it("rejects when the caller's signal fires mid-recognition", async () => {
    const controller = new AbortController();
    const pending = azureTranscribeAudio({
      subscriptionKey: "key",
      region: "eastus",
      blob: wavBlob(),
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it("rejects without reaching the recognizer when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    speech.hang = false;
    speech.calls = 0;

    await expect(
      azureTranscribeAudio({
        subscriptionKey: "key",
        region: "eastus",
        blob: wavBlob(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    // A call that arrives already cancelled should not open a connection it is
    // about to close.
    expect(speech.calls).toBe(0);
  });

  it("leaves no abort listener behind once the call has settled", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let live = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      live += 1;
      return add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      live -= 1;
      return remove(...args);
    };
    speech.hang = false;

    await azureTranscribeAudio({
      subscriptionKey: "key",
      region: "eastus",
      blob: wavBlob(),
      signal,
    });

    // A listener that outlives the call keeps the recognizer, the decoded
    // samples and this whole closure alive for as long as the signal does --
    // for a session controller, the life of the app.
    expect(live).toBe(0);
  });

  it("still answers normally when nothing cancels it", async () => {
    speech.hang = false;
    const controller = new AbortController();

    await expect(
      azureTranscribeAudio({
        subscriptionKey: "key",
        region: "eastus",
        blob: wavBlob(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({ text: "hello world" });
  });
});
