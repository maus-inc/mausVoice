import { CPU_DEVICE_VALUE } from "../types/ai.types";

export type LocalWhisperModel =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large"
  | "turbo"
  | "hindi2hinglish"
  | "parakeet-ctc-0.6b"
  | "parakeet-tdt-0.6b"
  | "canary-1b";

export type LocalModelCategory = "fast" | "whisper";

export type LocalModelOption = {
  value: LocalWhisperModel;
  label: string;
  helper: string;
  category: LocalModelCategory;
};

export const DEFAULT_LOCAL_WHISPER_MODEL: LocalWhisperModel = "tiny";

export const LOCAL_WHISPER_MODELS: LocalWhisperModel[] = [
  "parakeet-ctc-0.6b",
  "parakeet-tdt-0.6b",
  "canary-1b",
  "tiny",
  "base",
  "small",
  "medium",
  "turbo",
  "large",
  "hindi2hinglish",
];

type ModelMeta = {
  label: string;
  helper: string;
  category: LocalModelCategory;
};

const MODEL_LOOKUP: Record<LocalWhisperModel, ModelMeta> = {
  "parakeet-ctc-0.6b": {
    label: "NVIDIA Parakeet CTC 0.6B (120 MB)",
    helper: "Ultra-fast English dictation, zero hallucination loops",
    category: "fast",
  },
  "parakeet-tdt-0.6b": {
    label: "NVIDIA Parakeet TDT 0.6B (240 MB)",
    helper: "State-of-the-art English dictation speed & accuracy",
    category: "fast",
  },
  "canary-1b": {
    label: "NVIDIA Canary 1B (1.2 GB)",
    helper: "Multilingual STT + automatic punctuation & casing",
    category: "fast",
  },
  tiny: {
    label: "Whisper Tiny (77 MB)",
    helper: "Fastest, lowest accuracy",
    category: "whisper",
  },
  base: {
    label: "Whisper Base (148 MB)",
    helper: "Great balance of speed and accuracy",
    category: "whisper",
  },
  small: {
    label: "Whisper Small (488 MB)",
    helper: "Recommended with GPU acceleration",
    category: "whisper",
  },
  medium: {
    label: "Whisper Medium (1.53 GB)",
    helper: "Balanced quality and speed",
    category: "whisper",
  },
  turbo: {
    label: "Whisper Large v3 Turbo (1.6 GB)",
    helper: "Fast large model, great accuracy",
    category: "whisper",
  },
  large: {
    label: "Whisper Large v3 (3.1 GB)",
    helper: "Highest accuracy, requires GPU",
    category: "whisper",
  },
  hindi2hinglish: {
    label: "Whisper Hindi2Hinglish Apex (595 MB)",
    helper: "Hindi speech transcribed as Hinglish (Latin script)",
    category: "whisper",
  },
};

export const LOCAL_MODEL_OPTIONS: LocalModelOption[] = LOCAL_WHISPER_MODELS.map(
  (value) => ({
    value,
    ...MODEL_LOOKUP[value],
  }),
);

export const normalizeLocalWhisperModel = (
  value: string | null | undefined,
): LocalWhisperModel => {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "tiny" || normalized === "tiny.en") {
    return "tiny";
  }

  if (normalized === "base" || normalized === "base.en") {
    return "base";
  }

  if (normalized === "small" || normalized === "small.en") {
    return "small";
  }

  if (normalized === "medium" || normalized === "medium.en") {
    return "medium";
  }

  if (normalized === "large" || normalized === "large-v3") {
    return "large";
  }

  if (
    normalized === "turbo" ||
    normalized === "large-turbo" ||
    normalized === "large_v3_turbo" ||
    normalized === "large-v3-turbo"
  ) {
    return "turbo";
  }

  if (
    normalized === "hindi2hinglish" ||
    normalized === "hindi-hinglish" ||
    normalized === "hindi2hinglish-apex" ||
    normalized === "whisper-hindi2hinglish-apex"
  ) {
    return "hindi2hinglish";
  }

  if (
    normalized === "parakeet-ctc-0.6b" ||
    normalized === "parakeet-ctc" ||
    normalized === "parakeet_ctc" ||
    normalized === "parakeet_ctc_0.6b"
  ) {
    return "parakeet-ctc-0.6b";
  }

  if (
    normalized === "parakeet-tdt-0.6b" ||
    normalized === "parakeet-tdt" ||
    normalized === "parakeet_tdt" ||
    normalized === "parakeet_tdt_0.6b"
  ) {
    return "parakeet-tdt-0.6b";
  }

  if (
    normalized === "canary-1b" ||
    normalized === "canary" ||
    normalized === "canary_1b"
  ) {
    return "canary-1b";
  }

  return DEFAULT_LOCAL_WHISPER_MODEL;
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
