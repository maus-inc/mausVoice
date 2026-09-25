import { describe, expect, it } from "vitest";
import {
  buildGladiaCustomizations,
  createStreamingResampler,
  getGladiaSampleRate,
} from "./gladia.utils";

describe("getGladiaSampleRate", () => {
  it("passes supported capture rates through", () => {
    expect(getGladiaSampleRate(8000)).toBe(8000);
    expect(getGladiaSampleRate(44100)).toBe(44100);
    expect(getGladiaSampleRate(48000)).toBe(48000);
  });

  it("selects the nearest supported rate for unsupported capture rates", () => {
    expect(getGladiaSampleRate(22050)).toBe(16000);
    expect(getGladiaSampleRate(24000)).toBe(16000);
    expect(getGladiaSampleRate(96000)).toBe(48000);
  });

  it("rejects invalid microphone rates instead of silently dropping audio", () => {
    expect(() => getGladiaSampleRate(0)).toThrow("positive number");
    expect(() => getGladiaSampleRate(Number.NaN)).toThrow("positive number");
    expect(() => getGladiaSampleRate(Number.POSITIVE_INFINITY)).toThrow(
      "positive number",
    );
  });
});

describe("createStreamingResampler", () => {
  const makeSignal = (length: number): Float32Array =>
    Float32Array.from({ length }, (_, index) => Math.sin(index / 7));

  it("is stateful and produces the same output across arbitrary chunking", () => {
    const input = makeSignal(480);
    const allAtOnce = createStreamingResampler(48000, 16000);
    const expected = Float32Array.from([
      ...allAtOnce.process(input),
      ...allAtOnce.flush(),
    ]);

    const chunked = createStreamingResampler(48000, 16000);
    const actual = Float32Array.from([
      ...chunked.process(input.slice(0, 37)),
      ...chunked.process(input.slice(37, 191)),
      ...chunked.process(input.slice(191)),
      ...chunked.flush(),
    ]);

    expect(actual).toHaveLength(160);
    expect(actual).toEqual(expected);
  });

  it("supports fractional-phase upsampling without discontinuities", () => {
    const input = makeSignal(441);
    const allAtOnce = createStreamingResampler(44100, 48000);
    const expected = [...allAtOnce.process(input), ...allAtOnce.flush()];

    const chunked = createStreamingResampler(44100, 48000);
    const actual = [
      ...chunked.process(input.slice(0, 100)),
      ...chunked.process(input.slice(100, 275)),
      ...chunked.process(input.slice(275)),
      ...chunked.flush(),
    ];

    expect(actual).toHaveLength(480);
    expect(actual).toEqual(expected);
  });

  it("returns a defensive copy when no conversion is needed", () => {
    const input = makeSignal(10);
    const resampler = createStreamingResampler(16000, 16000);
    const output = resampler.process(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("rejects non-finite resampling rates", () => {
    expect(() => createStreamingResampler(Number.NaN, 16000)).toThrow(
      "finite positive",
    );
    expect(() =>
      createStreamingResampler(16000, Number.POSITIVE_INFINITY),
    ).toThrow("finite positive");
  });
});

describe("buildGladiaCustomizations", () => {
  it("maps canonical terms to vocabulary and replacements to custom spelling", () => {
    const result = buildGladiaCustomizations({
      sources: [" MausVoice ", "mouse voice", "MAUSVOICE", ""],
      replacements: [
        { source: "mouse voice", destination: "MausVoice" },
        { source: "maus voice", destination: "MausVoice" },
      ],
    });

    expect(result).toEqual({
      vocabulary: ["MausVoice"],
      spellingDictionary: {
        MausVoice: ["mouse voice", "maus voice"],
      },
      warnings: [],
    });
  });

  it("sanitizes input and warns when the safe entry budget is reached", () => {
    const result = buildGladiaCustomizations({
      sources: Array.from({ length: 105 }, (_, index) => `term ${index}\0`),
      replacements: [],
    });

    expect(result.vocabulary).toHaveLength(100);
    expect(result.vocabulary[0]).toBe("term 0");
    expect(result.warnings).toHaveLength(1);
  });
});
