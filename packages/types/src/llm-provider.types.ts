import type { PullStatus } from "./common.types";
import z from "zod";
import { providerInputZod } from "./common.types";

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

export const LlmProviderInputZod = providerInputZod satisfies z.ZodType<LlmProviderInput>;
