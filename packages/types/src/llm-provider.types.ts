import type { PullStatus } from "./common.types";
import z from "zod";
import { providerInputShape } from "./provider-input-shape";

export type LlmProvider = {
  id: string;
  provider: string;
  name: string;
  url: string;
  apiKeySuffix: string;
  model: string;
  tier: number;
  pullStatus: PullStatus;
  pullError: string | null;
  createdAt: string;
};

export type LlmProviderInput = {
  id?: string;
  provider: string;
  name: string;
  url: string;
  apiKey?: string;
  model: string;
  tier: number;
};

export const LlmProviderInputZod = z
  .object(providerInputShape)
  .strict() satisfies z.ZodType<LlmProviderInput>;
