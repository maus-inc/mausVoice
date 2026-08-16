import { defineMessage, type MessageDescriptor } from "react-intl";
import { CPU_DEVICE_VALUE } from "../types/ai.types";

export type LocalWhisperModel =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large"
  | "turbo"
  | "parakeet-ctc-0.6b"
  | "parakeet-tdt-0.6b"
  | "canary-1b"
  | "sense-voice";

export type LocalModelCategory = "fast" | "whisper" | "sherpa";

export type LocalModelOption = {
  value: LocalWhisperModel;
  label: MessageDescriptor;
  helper: MessageDescriptor;
  category: LocalModelCategory;
};

export const DEFAULT_LOCAL_WHISPER_MODEL: LocalWhisperModel = "tiny";

export const LOCAL_WHISPER_MODELS: LocalWhisperModel[] = [
  "parakeet-ctc-0.6b",
  "parakeet-tdt-0.6b",
  "canary-1b",
  "sense-voice",
  "tiny",
  "base",
  "small",
  "medium",
  "turbo",
  "large",
];

type ModelMeta = {
  label: MessageDescriptor;
  helper: MessageDescriptor;
  category: LocalModelCategory;
};

const MODEL_LOOKUP: Record<LocalWhisperModel, ModelMeta> = {
  "parakeet-ctc-0.6b": {
    label: defineMessage({
      defaultMessage: "NVIDIA Parakeet CTC 0.6B (613 MB)",
    }),
    helper: defineMessage({
      defaultMessage: "Ultra-fast English dictation, zero hallucination loops",
    }),
    category: "fast",
  },
  "parakeet-tdt-0.6b": {
    label: defineMessage({
      defaultMessage: "NVIDIA Parakeet TDT 0.6B (670 MB)",
    }),
    helper: defineMessage({
      defaultMessage: "State-of-the-art English dictation speed & accuracy",
    }),
    category: "fast",
  },
  "canary-1b": {
    label: defineMessage({ defaultMessage: "NVIDIA Canary 1B (1.03 GB)" }),
    helper: defineMessage({
      defaultMessage: "Multilingual STT + automatic punctuation & casing",
    }),
    category: "fast",
  },
  "sense-voice": {
    label: defineMessage({ defaultMessage: "SenseVoice (640 MB)" }),
    helper: defineMessage({
      defaultMessage:
        "Multilingual local ASR with punctuation and strong silence handling",
    }),
    category: "sherpa",
  },
  tiny: {
    label: defineMessage({ defaultMessage: "Whisper Tiny (77 MB)" }),
    helper: defineMessage({ defaultMessage: "Fastest, lowest accuracy" }),
    category: "whisper",
  },
  base: {
    label: defineMessage({ defaultMessage: "Whisper Base (148 MB)" }),
    helper: defineMessage({
      defaultMessage: "Great balance of speed and accuracy",
    }),
    category: "whisper",
  },
  small: {
    label: defineMessage({ defaultMessage: "Whisper Small (488 MB)" }),
    helper: defineMessage({
      defaultMessage: "Recommended with GPU acceleration",
    }),
    category: "whisper",
  },
  medium: {
    label: defineMessage({ defaultMessage: "Whisper Medium (1.53 GB)" }),
    helper: defineMessage({ defaultMessage: "Balanced quality and speed" }),
    category: "whisper",
  },
  turbo: {
    label: defineMessage({
      defaultMessage: "Whisper Large v3 Turbo (1.6 GB)",
    }),
    helper: defineMessage({
      defaultMessage: "Fast large model, great accuracy",
    }),
    category: "whisper",
  },
  large: {
    label: defineMessage({ defaultMessage: "Whisper Large v3 (3.1 GB)" }),
    helper: defineMessage({ defaultMessage: "Highest accuracy, requires GPU" }),
    category: "whisper",
  },
};

export const LOCAL_MODEL_OPTIONS: LocalModelOption[] = LOCAL_WHISPER_MODELS.map(
  (value) => ({
    value,
    ...MODEL_LOOKUP[value],
  }),
);

// Every canonical model id resolves to itself; legacy/alternate spellings as
// persisted by older builds or entered manually map onto the canonical value.
const CANONICAL_MODEL_ALIASES = Object.fromEntries(
  LOCAL_WHISPER_MODELS.map((model) => [model, model]),
) as Record<string, LocalWhisperModel>;

const LEGACY_MODEL_ALIASES: Record<string, LocalWhisperModel> = {
  "tiny.en": "tiny",
  "base.en": "base",
  "small.en": "small",
  "medium.en": "medium",
  "large-v3": "large",
  "large-turbo": "turbo",
  large_v3_turbo: "turbo",
  "large-v3-turbo": "turbo",
  "parakeet-ctc": "parakeet-ctc-0.6b",
  parakeet_ctc: "parakeet-ctc-0.6b",
  "parakeet_ctc_0.6b": "parakeet-ctc-0.6b",
  "parakeet-tdt": "parakeet-tdt-0.6b",
  parakeet_tdt: "parakeet-tdt-0.6b",
  "parakeet_tdt_0.6b": "parakeet-tdt-0.6b",
  canary: "canary-1b",
  canary_1b: "canary-1b",
};

const LOCAL_WHISPER_MODEL_ALIASES: Record<string, LocalWhisperModel> = {
  ...CANONICAL_MODEL_ALIASES,
  ...LEGACY_MODEL_ALIASES,
};

export const normalizeLocalWhisperModel = (
  value: string | null | undefined,
): LocalWhisperModel => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_LOCAL_WHISPER_MODEL;
  }
  return LOCAL_WHISPER_MODEL_ALIASES[normalized] ?? DEFAULT_LOCAL_WHISPER_MODEL;
};

export const isGpuPreferredTranscriptionDevice = (
  device: string | null | undefined,
): boolean => {
  const normalized = device?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized === "gpu" ||
    normalized.startsWith("gpu:") ||
    normalized.startsWith("gpu-")
  );
};

export const supportsGpuTranscriptionDevice = (): boolean => true;

export const normalizeTranscriptionDevice = (
  device: string | null | undefined,
): string => {
  const normalized = device?.trim().toLowerCase();
  if (!normalized) {
    return CPU_DEVICE_VALUE;
  }

  const normalizedLegacyGpu = normalized.replace(/^gpu-(\d+)$/, "gpu:$1");
  const normalizedLegacyCpu = normalizedLegacyGpu.replace(
    /^cpu-(\d+)$/,
    "cpu:$1",
  );

  if (
    normalizedLegacyCpu === CPU_DEVICE_VALUE ||
    normalizedLegacyCpu.startsWith("cpu:")
  ) {
    return normalizedLegacyCpu;
  }

  if (normalizedLegacyCpu === "gpu" || normalizedLegacyCpu.startsWith("gpu:")) {
    return normalizedLegacyCpu;
  }

  return CPU_DEVICE_VALUE;
};

export const getTranscriptionSidecarDeviceId = (
  device: string | null | undefined,
): string | undefined => {
  const normalized = normalizeTranscriptionDevice(device);
  return normalized.includes(":") ? normalized : undefined;
};
