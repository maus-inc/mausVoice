import { describe, expect, it } from "vitest";
import {
  getDeviceModelTier,
  getModelFit,
  getRecommendedModel,
} from "./model-recommendation.utils";
import { SystemCapabilities } from "../types/system-capabilities.types";

const caps = (ramGb: number, withGpu = false): SystemCapabilities => ({
  ramGb,
  cpuCores: 8,
  gpus: withGpu
    ? [
        {
          name: "Test GPU",
          vendor: 0x10de,
          device: 1,
          deviceType: "DiscreteGpu",
          backend: "Vulkan",
        },
      ]
    : [],
});

describe("getDeviceModelTier", () => {
  it("lowers the tier for small-RAM machines and raises it with a GPU", () => {
    expect(getDeviceModelTier(caps(3))).toBe(0);
    expect(getDeviceModelTier(caps(6))).toBe(1);
    expect(getDeviceModelTier(caps(12))).toBe(2);
    expect(getDeviceModelTier(caps(32))).toBe(3);
    expect(getDeviceModelTier(caps(3, true))).toBe(1);
    expect(getDeviceModelTier(caps(12, true))).toBe(3);
  });

  it("treats unknown capabilities as the most constrained tier", () => {
    expect(getDeviceModelTier(null)).toBe(0);
  });
});

describe("getModelFit", () => {
  it("discourages large on tiny machines", () => {
    expect(getModelFit(caps(3), "large").level).toBe("discouraged");
  });

  it("recommends small models on capable machines", () => {
    expect(getModelFit(caps(32), "small").level).toBe("recommended");
  });

  it("allows large with a GPU on an 8GB machine (one-tier relax)", () => {
    const fit = getModelFit(caps(8, true), "large");
    expect(fit.level === "acceptable" || fit.level === "caution").toBe(true);
  });
});

describe("getRecommendedModel", () => {
  it("picks base on constrained machines and turbo/large on strong ones", () => {
    expect(getRecommendedModel(caps(3))).toBe("base");
    expect(getRecommendedModel(caps(6))).toBe("small");
    expect(getRecommendedModel(caps(12))).toBe("medium");
    expect(getRecommendedModel(caps(32))).toBe("turbo");
    expect(getRecommendedModel(caps(32, true))).toBe("large");
  });
});
