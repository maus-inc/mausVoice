import { describe, expect, it } from "vitest";
import {
  buildTranscriptionMetadata,
  toTranscriptionRecordMetadata,
} from "./transcription-metadata.utils";

describe("transcription record metadata", () => {
  it("uses null for absent metadata", () => {
    expect(toTranscriptionRecordMetadata(undefined, null)).toEqual({
      modelSize: null,
      inferenceDevice: null,
      transcriptionPrompt: null,
      transcriptionApiKeyId: null,
      transcriptionMode: null,
      transcriptionDurationMs: null,
      postProcessPrompt: null,
      postProcessApiKeyId: null,
      postProcessMode: null,
      postProcessDevice: null,
      postProcessModel: null,
      postProcessProvider: null,
      postProcessFailed: null,
      postProcessFallback: null,
      postProcessError: null,
      postprocessDurationMs: null,
    });
  });

  it("preserves all supplied values, including false, zero, and empty strings", () => {
    expect(
      toTranscriptionRecordMetadata(
        {
          modelSize: "tiny",
          inferenceDevice: "cpu",
          transcriptionPrompt: "",
          transcriptionApiKeyId: "transcribe-key",
          transcriptionMode: "local",
          transcriptionDurationMs: 0,
        },
        {
          postProcessPrompt: "style",
          postProcessApiKeyId: "style-key",
          postProcessMode: "api",
          postProcessDevice: "gpu",
          postProcessModel: "model",
          postProcessProvider: "provider",
          postProcessFailed: false,
          postProcessFallback: true,
          postProcessError: "",
          postprocessDurationMs: 0,
        },
      ),
    ).toEqual({
      modelSize: "tiny",
      inferenceDevice: "cpu",
      transcriptionPrompt: "",
      transcriptionApiKeyId: "transcribe-key",
      transcriptionMode: "local",
      transcriptionDurationMs: 0,
      postProcessPrompt: "style",
      postProcessApiKeyId: "style-key",
      postProcessMode: "api",
      postProcessDevice: "gpu",
      postProcessModel: "model",
      postProcessProvider: "provider",
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: "",
      postprocessDurationMs: 0,
    });
  });
});

describe("transcription request metadata", () => {
  it("prefers provider metadata and rounds request duration", () => {
    expect(
      buildTranscriptionMetadata({
        provider: {
          modelSize: "provider",
          inferenceDevice: "gpu",
          transcriptionMode: "api",
        },
        modelSize: "local",
        durationMs: 12.6,
        prompt: "",
        apiKeyId: "key",
      }),
    ).toEqual({
      modelSize: "provider",
      inferenceDevice: "gpu",
      transcriptionMode: "api",
      transcriptionDurationMs: 13,
      transcriptionPrompt: "",
      transcriptionApiKeyId: "key",
    });
  });
  it("falls back for missing or empty provider fields", () => {
    expect(
      buildTranscriptionMetadata({
        provider: {
          modelSize: "",
          inferenceDevice: "",
          transcriptionMode: null,
        },
        modelSize: "local",
        durationMs: 0,
        prompt: "prompt",
        apiKeyId: null,
      }),
    ).toEqual({
      modelSize: "local",
      inferenceDevice: null,
      transcriptionMode: null,
      transcriptionDurationMs: 0,
      transcriptionPrompt: "prompt",
      transcriptionApiKeyId: null,
    });
    expect(
      buildTranscriptionMetadata({
        provider: undefined,
        modelSize: "",
        durationMs: 0,
        prompt: "",
        apiKeyId: null,
      }).modelSize,
    ).toBeNull();
  });
});
