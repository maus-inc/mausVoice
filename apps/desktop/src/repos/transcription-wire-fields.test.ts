import type { Transcription } from "@maus-inc/types";
import { describe, expect, it } from "vitest";
import { transcriptionWireFields } from "./transcription-wire-fields";

const base: Transcription = {
  id: "t",
  transcript: "text",
  createdAt: "2026-01-01T00:00:00Z",
  createdByUserId: "u",
  isDeleted: false,
};

describe("transcriptionWireFields", () => {
  it("maps every omitted metadata field to a wire null", () => {
    expect(transcriptionWireFields(base)).toEqual({
      modelSize: null,
      inferenceDevice: null,
      rawTranscript: null,
      sanitizedTranscript: null,
      transcriptionPrompt: null,
      postProcessPrompt: null,
      transcriptionApiKeyId: null,
      postProcessApiKeyId: null,
      transcriptionMode: null,
      postProcessMode: null,
      postProcessDevice: null,
      postProcessModel: null,
      postProcessProvider: null,
      postProcessFailed: null,
      postProcessFallback: null,
      postProcessError: null,
      transcriptionDurationMs: null,
      postprocessDurationMs: null,
      warnings: null,
      remoteStatus: null,
      remoteDeviceId: null,
    });
  });

  it("preserves false, zero, empty strings and empty warning lists", () => {
    const warnings: string[] = [];
    const fields = transcriptionWireFields({
      ...base,
      postProcessFailed: false,
      postProcessFallback: false,
      transcriptionDurationMs: 0,
      postprocessDurationMs: 0,
      rawTranscript: "",
      warnings,
      remoteStatus: "sent",
      remoteDeviceId: "device",
    });
    expect(fields).toMatchObject({
      postProcessFailed: false,
      postProcessFallback: false,
      transcriptionDurationMs: 0,
      postprocessDurationMs: 0,
      rawTranscript: "",
      warnings: [],
      remoteStatus: "sent",
      remoteDeviceId: "device",
    });
    expect(fields.warnings).toBe(warnings);
  });
});
