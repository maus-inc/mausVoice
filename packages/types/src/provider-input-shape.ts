import z from "zod";

/** Fields common to the persisted speech and language-model provider inputs. */
export const providerInputShape = {
  id: z.string().optional(),
  provider: z.string(),
  name: z.string(),
  url: z.string(),
  apiKey: z.string().default(""),
  model: z.string(),
  tier: z.number().int(),
};
