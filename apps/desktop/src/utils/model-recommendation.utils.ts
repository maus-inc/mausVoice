import { LocalWhisperModel } from "./local-transcription.utils";
import { SystemCapabilities } from "../types/system-capabilities.types";

/**
 * Device-fit tiers for local transcription models, RAM-driven with a GPU
 * relaxing the tier by one step. Purely advisory: selections are never
 * hard-blocked, but discouraged combos get the strongest wording.
 */
export type ModelFitLevel =
  | "recommended"
  | "acceptable"
  | "caution"
  | "discouraged";

const MODEL_TIER: Record<LocalWhisperModel, number> = {
  tiny: 0,
  base: 0,
  small: 1,
  medium: 2,
  turbo: 2,
  large: 3,
};

const hasUsableGpu = (capabilities: SystemCapabilities | null): boolean =>
  capabilities?.gpus.some(
    (info) => info.backend === "Vulkan" && info.deviceType === "DiscreteGpu",
  ) ?? false;

/**
 * Highest model tier the device can comfortably run: 0 = tiny/base,
 * 1 = small, 2 = medium/turbo, 3 = large. A usable GPU raises the
 * ceiling by one tier.
 */
export const getDeviceModelTier = (
  capabilities: SystemCapabilities | null,
): number => {
  const ramGb = capabilities?.ramGb ?? 0;
  let tier: number;
  if (ramGb < 4) {
    tier = 0;
  } else if (ramGb < 8) {
    tier = 1;
  } else if (ramGb < 16) {
    tier = 2;
  } else {
    tier = 3;
  }

  if (hasUsableGpu(capabilities)) {
    tier = Math.min(3, tier + 1);
  }

  return tier;
};

export type ModelFit = {
  level: ModelFitLevel;
  /** Difference between the device tier and the model tier (≥0 = fits). */
  tierGap: number;
};

export const getModelFit = (
  capabilities: SystemCapabilities | null,
  model: LocalWhisperModel,
): ModelFit => {
  const deviceTier = getDeviceModelTier(capabilities);
  const tierGap = deviceTier - MODEL_TIER[model];

  if (tierGap >= 1) {
    return { level: "recommended", tierGap };
  }
  if (tierGap === 0) {
    return { level: "acceptable", tierGap };
  }
  if (tierGap === -1) {
    return { level: "caution", tierGap };
  }
  return { level: "discouraged", tierGap };
};

/** The best-fitting model for this device (for the advisory chip). */
export const getRecommendedModel = (
  capabilities: SystemCapabilities | null,
): LocalWhisperModel => {
  const deviceTier = getDeviceModelTier(capabilities);
  switch (deviceTier) {
    case 0:
      return "base";
    case 1:
      return "small";
    case 2:
      return "medium";
    default:
      return hasUsableGpu(capabilities) ? "large" : "turbo";
  }
};

export const formatCapabilitySummary = (
  capabilities: SystemCapabilities | null,
): string => {
  if (!capabilities) {
    return "";
  }
  const ram = `${Math.round(capabilities.ramGb)} GB RAM`;
  const cores =
    capabilities.cpuCores > 0 ? `${capabilities.cpuCores} cores` : null;
  const gpu = hasUsableGpu(capabilities) ? "GPU" : "no GPU";
  return [ram, cores, gpu].filter(Boolean).join(", ");
};
