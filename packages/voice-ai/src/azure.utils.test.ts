import { beforeEach, describe, expect, it, vi } from "vitest";
import { azureTestIntegration, azureTranscribeAudio } from "./azure.utils";

// The Azure SDK is mocked at module level: azureTranscribeAudio wires real
// recognizer objects, so the test only needs fromSubscription/fromRecognizer
// shims plus a recognizer that resolves immediately.
const capturedPhrases: string[] = vi.hoisted(() => []);
// What the mocked recognizer reports back, so the credential probe can be
// driven through both a completed recognition and a rejected one.
const speech = vi.hoisted(() => ({
  error: null as string | null,
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
      callback({ reason: "recognized", text: "hello world" });
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

  it("reports failure when the region is not one the resource exists in", async () => {
    // Verbatim from the SDK's own validation table
    // (RestConfigBase.privRestErrors.authInvalidSubscriptionRegion), and the
    // message that used to be read as a success because it mentions neither
    // "authentication" nor "subscription".
    speech.error = "You must specify the Cognitive Speech region to use.";

    await expect(
      azureTestIntegration({ subscriptionKey: "key", region: "westus" }),
    ).resolves.toBe(false);
    expect(speech.calls).toBe(1);
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
});
