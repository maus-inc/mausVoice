import { describe, expect, it, vi } from "vitest";
import { azureTranscribeAudio } from "./azure.utils";

// The Azure SDK is mocked at module level: azureTranscribeAudio wires real
// recognizer objects, so the test only needs fromSubscription/fromRecognizer
// shims plus a recognizer that resolves immediately.
const capturedPhrases: string[] = vi.hoisted(() => []);

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: {
    fromSubscription: () => ({
      speechRecognitionLanguage: "",
    }),
  },
  AudioStreamFormat: {
    getWaveFormatPCM: () => ({}),
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
    recognizeOnceAsync(callback: (result: unknown) => void) {
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
