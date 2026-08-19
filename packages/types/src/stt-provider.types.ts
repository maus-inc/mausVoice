import z from "zod";
import { providerInputZod } from "./common.types";
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

export const SttProviderInputZod = providerInputZod satisfies z.ZodType<SttProviderInput>;
