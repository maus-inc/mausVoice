import type { GladiaCustomizations } from "@maus-inc/voice-ai";
import type { DictionaryEntries } from "./prompt.utils";

export const GLADIA_SUPPORTED_SAMPLE_RATES = [
  8000, 16000, 32000, 44100, 48000,
] as const;
export type GladiaSampleRate = (typeof GLADIA_SUPPORTED_SAMPLE_RATES)[number];

const MAX_VOCABULARY_ENTRIES = 100;
const MAX_DICTIONARY_CHARACTERS = 10_000;

const sanitizeValue = (value: string): string =>
  value
    .replace(/\0/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0001-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const getGladiaSampleRate = (
  inputSampleRate: number,
): GladiaSampleRate => {
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    throw new Error("The microphone sample rate must be a positive number.");
  }
  if (
    GLADIA_SUPPORTED_SAMPLE_RATES.includes(inputSampleRate as GladiaSampleRate)
  ) {
    return inputSampleRate as GladiaSampleRate;
  }

  return GLADIA_SUPPORTED_SAMPLE_RATES.reduce((closest, candidate) =>
    Math.abs(candidate - inputSampleRate) < Math.abs(closest - inputSampleRate)
      ? candidate
      : closest,
  );
};

export const buildGladiaCustomizations = (
  entries: DictionaryEntries,
): GladiaCustomizations => {
  const replacementSources = new Set(
    entries.replacements.map((rule) =>
      sanitizeValue(rule.source).toLowerCase(),
    ),
  );
  const values = new Map<string, string>();
  const spellingByDestination = new Map<
    string,
    { destination: string; variants: Map<string, string> }
  >();

  const addVocabulary = (candidate: string) => {
    const sanitized = sanitizeValue(candidate);
    if (sanitized && !values.has(sanitized.toLowerCase())) {
      values.set(sanitized.toLowerCase(), sanitized);
    }
  };

  for (const source of entries.sources) {
    const sanitized = sanitizeValue(source);
    if (sanitized && !replacementSources.has(sanitized.toLowerCase())) {
      addVocabulary(sanitized);
    }
  }

  for (const rule of entries.replacements) {
    const source = sanitizeValue(rule.source);
    const destination = sanitizeValue(rule.destination);
    if (!source || !destination) {
      continue;
    }

    addVocabulary(destination);
    const key = destination.toLowerCase();
    const current = spellingByDestination.get(key) ?? {
      destination,
      variants: new Map<string, string>(),
    };
    current.variants.set(source.toLowerCase(), source);
    spellingByDestination.set(key, current);
  }

  const warnings: string[] = [];
  const vocabulary: string[] = [];
  let characterCount = 0;
  for (const value of values.values()) {
    if (
      vocabulary.length >= MAX_VOCABULARY_ENTRIES ||
      characterCount + value.length > MAX_DICTIONARY_CHARACTERS
    ) {
      warnings.push(
        "Some dictionary entries were omitted from Gladia provider hints because the safe payload budget was reached.",
      );
      break;
    }
    vocabulary.push(value);
    characterCount += value.length;
  }

  const spellingDictionary: Record<string, string[]> = {};
  for (const { destination, variants } of spellingByDestination.values()) {
    const variantValues = Array.from(variants.values());
    const additionalCharacters =
      destination.length +
      variantValues.reduce((sum, value) => sum + value.length, 0);
    if (
      Object.keys(spellingDictionary).length >= MAX_VOCABULARY_ENTRIES ||
      characterCount + additionalCharacters > MAX_DICTIONARY_CHARACTERS
    ) {
      warnings.push(
        "Some Gladia custom-spelling rules were omitted because the safe payload budget was reached.",
      );
      break;
    }
    spellingDictionary[destination] = variantValues;
    characterCount += additionalCharacters;
  }

  return {
    vocabulary,
    spellingDictionary,
    warnings: Array.from(new Set(warnings)),
  };
};

export type StreamingResampler = {
  process: (input: Float32Array) => Float32Array;
  flush: () => Float32Array;
  reset: () => void;
};

const concatSamples = (
  left: Float32Array,
  right: Float32Array,
): Float32Array => {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const output = new Float32Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
};

export const createStreamingResampler = (
  inputRate: number,
  outputRate: number,
): StreamingResampler => {
  if (
    !Number.isFinite(inputRate) ||
    !Number.isFinite(outputRate) ||
    inputRate <= 0 ||
    outputRate <= 0
  ) {
    throw new Error("Sample rates must be finite positive numbers.");
  }

  const ratio = inputRate / outputRate;
  let buffer = new Float32Array(0);
  let bufferStartSample = 0;
  let totalInputSamples = 0;
  let nextOutputSample = 0;

  const reset = () => {
    buffer = new Float32Array(0);
    bufferStartSample = 0;
    totalInputSamples = 0;
    nextOutputSample = 0;
  };

  const processBuffered = (flush: boolean): Float32Array => {
    if (buffer.length === 0) {
      return new Float32Array(0);
    }

    const output: number[] = [];
    const expectedOutputSamples = Math.round(
      (totalInputSamples * outputRate) / inputRate,
    );
    while (nextOutputSample < expectedOutputSamples) {
      const absolutePosition = nextOutputSample * ratio;
      const localPosition = absolutePosition - bufferStartSample;
      if (
        flush
          ? localPosition >= buffer.length
          : localPosition + 1 >= buffer.length
      ) {
        break;
      }

      const lower = Math.floor(localPosition);
      const fraction = localPosition - lower;
      const a = buffer[lower] ?? 0;
      const b = buffer[Math.min(lower + 1, buffer.length - 1)] ?? a;
      output.push(a + fraction * (b - a));
      nextOutputSample++;
    }

    const nextLocalPosition = nextOutputSample * ratio - bufferStartSample;
    const consumed = Math.min(
      buffer.length,
      Math.max(0, Math.floor(nextLocalPosition)),
    );
    if (consumed > 0) {
      buffer = buffer.slice(consumed);
      bufferStartSample += consumed;
    }
    const result = Float32Array.from(output);
    if (flush) {
      reset();
    }
    return result;
  };

  return {
    process: (input) => {
      if (input.length === 0) return new Float32Array(0);
      if (inputRate === outputRate) return input.slice();
      buffer = concatSamples(buffer, input);
      totalInputSamples += input.length;
      return processBuffered(false);
    },
    flush: () => {
      if (inputRate === outputRate) return new Float32Array(0);
      return processBuffered(true);
    },
    reset,
  };
};
