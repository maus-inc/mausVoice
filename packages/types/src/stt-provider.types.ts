import z from "zod";
import { providerInputShape } from "./provider-input-shape";
import type { PullStatus } from "./common.types";

export type SttProvider = {
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

export type SttProviderInput = {
  id?: string;
  provider: string;
  name: string;
  url: string;
  apiKey?: string;
  model: string;
  tier: number;
};

export const SttProviderInputZod = z
  .object(providerInputShape)
  .strict() satisfies z.ZodType<SttProviderInput>;
