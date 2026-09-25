import { describe, expect, it } from "vitest";
import { parseSdkTranscription } from "./transcription.utils";

describe("parseSdkTranscription segments", () => {
  it("reads no_speech_prob and avg_logprob for the silence gate", () => {
    const result = parseSdkTranscription({
      text: "hello world",
      segments: [
        { text: "hello", no_speech_prob: 0.95, avg_logprob: -0.2 },
        { text: " world" },
      ],
    });

    expect(result.segments).toEqual([
      { text: "hello", noSpeechProb: 0.95, avgLogprob: -0.2 },
      { text: " world", noSpeechProb: undefined, avgLogprob: undefined },
    ]);
  });
});
