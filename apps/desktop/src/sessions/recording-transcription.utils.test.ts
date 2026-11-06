import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("../utils/log.utils", () => ({ getLogger: () => ({ info: log }) }));

import {
  usableRecordingAudio,
  wholeRecordingResult,
} from "./recording-transcription.utils";

describe("usableRecordingAudio", () => {
  it.each([
    { samples: [1], sampleRate: undefined },
    { samples: [1], sampleRate: 0 },
    { samples: [1], sampleRate: -1 },
    { samples: [1], sampleRate: NaN },
    { samples: [1], sampleRate: Infinity },
    { samples: [], sampleRate: 16000 },
    { samples: [1], sampleRate: 16000, captureFailed: true },
  ])("rejects a missing rate, non-positive rate, or empty audio", (audio) => {
    expect(usableRecordingAudio(audio)).toBeNull();
  });

  it("keeps the original sample buffer and rate for a valid recording", () => {
    const samples = new Float32Array([0.1]);
    expect(usableRecordingAudio({ samples, sampleRate: 16000 })).toEqual({
      samples,
      sampleRate: 16000,
    });
    expect(usableRecordingAudio({ samples, sampleRate: 16000 })?.samples).toBe(
      samples,
    );
  });
});

describe("wholeRecordingResult", () => {
  it("preserves raw text and metadata, merges warnings in order, and logs success", () => {
    const metadata = { transcriptionMode: "local" as const };
    const result = wholeRecordingResult(
      {
        rawTranscript: " raw ",
        sanitizedTranscript: "raw",
        metadata,
        warnings: ["provider"],
      },
      ["startup"],
      "completed",
    );
    expect(result).toEqual({
      rawTranscript: " raw ",
      metadata,
      warnings: ["startup", "provider"],
    });
    expect(result.metadata).toBe(metadata);
    expect(log).toHaveBeenCalledWith("completed");
  });
});
