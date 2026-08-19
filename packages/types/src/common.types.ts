import z from "zod";

export type Nullable<T> = T | null;

export type EmptyObject = Record<string, never>;

export type Replace<T, S, D> = {
  [K in keyof T]: T[K] extends S
    ? D
    : T[K] extends S | null
      ? D | null
      : T[K] extends S | undefined
        ? D | undefined
        : T[K] extends S | null | undefined
          ? D | null | undefined
          : T[K];
};

export type JsonResponse = {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
};

export type TranscriptionMode = "local" | "api";

export type PostProcessingMode = "none" | "api";

export type AgentMode = PostProcessingMode | "openclaw";

export type DictationPillVisibility = "hidden" | "while_active" | "persistent";

export type PillResetMonitorStrategy = "current" | "cursor";

export type PullStatus = "in_progress" | "error" | "complete";

export const STYLING_MODES = ["app", "manual"] as const;
export type StylingMode = (typeof STYLING_MODES)[number];
export const StylingModeZod = z.enum(STYLING_MODES);

export type ProviderInputBase = {
  id?: string;
  provider: string;
  name: string;
  url: string;
  apiKey?: string;
  model: string;
  tier: number;
};

export const providerInputZod = z
  .object({
    id: z.string().optional(),
    provider: z.string(),
    name: z.string(),
    url: z.string(),
    apiKey: z.string().default(""),
    model: z.string(),
    tier: z.number().int(),
  })
  .strict();
