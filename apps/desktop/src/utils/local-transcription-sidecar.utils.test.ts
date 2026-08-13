import { describe, expect, it } from "vitest";

import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  normalizeTranscriptionDevice,
  normalizeLocalWhisperModel,
  supportsGpuTranscriptionDevice,
} from "./local-transcription.utils";

describe("local-transcription-sidecar manager helpers", () => {
  it("normalizes model values to supported sidecar models", () => {
    expect(normalizeLocalWhisperModel("tiny")).toBe("tiny");
    expect(normalizeLocalWhisperModel("tiny.en")).toBe("tiny");
    expect(normalizeLocalWhisperModel("base")).toBe("base");
    expect(normalizeLocalWhisperModel("base.en")).toBe("base");
    expect(normalizeLocalWhisperModel("small")).toBe("small");
    expect(normalizeLocalWhisperModel("small.en")).toBe("small");
    expect(normalizeLocalWhisperModel("medium")).toBe("medium");
    expect(normalizeLocalWhisperModel("medium.en")).toBe("medium");
    expect(normalizeLocalWhisperModel("large-turbo")).toBe("turbo");
    expect(normalizeLocalWhisperModel("large-v3")).toBe("large");
    expect(normalizeLocalWhisperModel("large")).toBe("large");
    expect(normalizeLocalWhisperModel("hindi2hinglish")).toBe("hindi2hinglish");
    expect(normalizeLocalWhisperModel("hindi-hinglish")).toBe("hindi2hinglish");
    expect(normalizeLocalWhisperModel("hindi2hinglish-apex")).toBe(
      "hindi2hinglish",
    );
    expect(normalizeLocalWhisperModel("whisper-hindi2hinglish-apex")).toBe(
      "hindi2hinglish",
    );
    expect(normalizeLocalWhisperModel("parakeet-ctc-0.6b")).toBe(
      "parakeet-ctc-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet-ctc")).toBe(
      "parakeet-ctc-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet_ctc")).toBe(
      "parakeet-ctc-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet_ctc_0.6b")).toBe(
      "parakeet-ctc-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet-tdt-0.6b")).toBe(
      "parakeet-tdt-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet-tdt")).toBe(
      "parakeet-tdt-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet_tdt")).toBe(
      "parakeet-tdt-0.6b",
    );
    expect(normalizeLocalWhisperModel("parakeet_tdt_0.6b")).toBe(
      "parakeet-tdt-0.6b",
    );
    expect(normalizeLocalWhisperModel("canary-1b")).toBe("canary-1b");
    expect(normalizeLocalWhisperModel("canary")).toBe("canary-1b");
    expect(normalizeLocalWhisperModel("canary_1b")).toBe("canary-1b");
  });

  it("defaults unknown model values to tiny", () => {
    expect(normalizeLocalWhisperModel("unknown")).toBe("tiny");
    expect(normalizeLocalWhisperModel(null)).toBe("tiny");
  });

  it("treats any non-cpu device value as gpu preference on supported OSes", () => {
    expect(isGpuPreferredTranscriptionDevice("cpu")).toBe(false);
    expect(isGpuPreferredTranscriptionDevice("cpu:0")).toBe(false);
    expect(isGpuPreferredTranscriptionDevice("gpu")).toBe(true);
    expect(isGpuPreferredTranscriptionDevice("gpu:0")).toBe(true);
    expect(isGpuPreferredTranscriptionDevice("gpu-0")).toBe(true);
  });

  it("advertises GPU selection support", () => {
    expect(supportsGpuTranscriptionDevice()).toBe(true);
  });

  it("normalizes transcription devices while preserving concrete IDs", () => {
    expect(normalizeTranscriptionDevice("cpu")).toBe("cpu");
    expect(normalizeTranscriptionDevice("cpu:0")).toBe("cpu:0");
    expect(normalizeTranscriptionDevice("gpu")).toBe("gpu");
    expect(normalizeTranscriptionDevice("gpu:2")).toBe("gpu:2");
    expect(normalizeTranscriptionDevice("gpu-2")).toBe("gpu:2");
    expect(normalizeTranscriptionDevice("unknown")).toBe("cpu");
  });

  it("extracts sidecar device IDs only for concrete selections", () => {
    expect(getTranscriptionSidecarDeviceId("cpu")).toBeUndefined();
    expect(getTranscriptionSidecarDeviceId("gpu")).toBeUndefined();
    expect(getTranscriptionSidecarDeviceId("cpu:0")).toBe("cpu:0");
    expect(getTranscriptionSidecarDeviceId("gpu:1")).toBe("gpu:1");
  });
});
