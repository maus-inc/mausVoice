import { describe, expect, it } from "vitest";
import {
  AUDIO_CHECKSUM_SEED,
  checksumFloatSamples,
  checksumRecordingSamples,
  hasFiniteAudioSamples,
} from "./audio-samples.utils";

describe("audio sample validation and fingerprints", () => {
  it("matches whole and incrementally hashed float views", () => {
    const values = Float32Array.from({ length: 9_000 }, (_, index) =>
      Math.sin(index),
    );
    const first = checksumFloatSamples(
      values.subarray(0, 3_000),
      AUDIO_CHECKSUM_SEED,
    );
    const next = checksumFloatSamples(values.subarray(3_000, 6_000), first);
    expect(checksumFloatSamples(values.subarray(6_000), next)).toBe(
      checksumFloatSamples(values),
    );
    expect(checksumRecordingSamples(Array.from(values))).toBe(
      checksumFloatSamples(values),
    );
    const transported = JSON.parse(
      JSON.stringify(Array.from(values)),
    ) as number[];
    expect(checksumRecordingSamples(transported)).toBe(
      checksumFloatSamples(values),
    );
    expect(checksumRecordingSamples(values)).toBe(checksumFloatSamples(values));
  });

  it("treats positive and negative zero alike across JSON transport", () => {
    const samples = new Float32Array([-0, 0.25, -0]);
    const transported = JSON.parse(
      JSON.stringify(Array.from(samples)),
    ) as number[];
    expect(checksumRecordingSamples(samples)).toBe(
      checksumRecordingSamples(transported),
    );
  });

  it("handles empty recordings and rejects non-finite or nonnumeric samples", () => {
    expect(checksumRecordingSamples([])).toBe(AUDIO_CHECKSUM_SEED);
    expect(checksumRecordingSamples(new Float32Array())).toBe(
      AUDIO_CHECKSUM_SEED,
    );
    for (const sample of [NaN, Infinity, -Infinity, 1e300, null, undefined]) {
      const samples = [0, sample as number];
      expect(hasFiniteAudioSamples(samples)).toBe(false);
      expect(checksumRecordingSamples(samples)).toBeNull();
    }
  });
});
