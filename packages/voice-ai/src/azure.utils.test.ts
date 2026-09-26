import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  azureTestIntegration,
  azureTranscribeAudio,
  buildSilentProbeWav,
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

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: {
    fromSubscription: (key: string, region: string) => {
      speech.subscriptions.push([key, region]);
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
});
