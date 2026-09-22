import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import { Replace } from "./common.types";

/**
 * Optional structured hints for a style.  They are deliberately additive so
 * tones created by older versions (which only contain a free-form prompt) keep
 * working without a migration at the API boundary.
 */
export type ToneStructuredFields = {
  /** A human-readable grouping such as "writing", "developer", or "notes". */
  category?: string;
  /** A short output-size hint, for example "1-3 sentences" or "5 bullets". */
  outputLength?: string;
  /** Optional few-shot example shown to the post-processing model. */
  exampleInputOutput?: string;
};

export type DatabaseTone = ToneStructuredFields & {
  id: string;
  name: string;
  description?: string;
  promptTemplate: string;
  isSystem: boolean;
  createdAt: FiremixTimestamp;
  sortOrder: number;
  isGlobal?: boolean;
  isDeprecated?: boolean;
  shouldDisablePostProcessing?: boolean;
  systemPromptTemplate?: string;
  isTemplateTone?: boolean;
};

export type Tone = Replace<DatabaseTone, FiremixTimestamp, number>;

export type ToneDoc = {
  id: string;
  toneIds: string[];
  toneById: Record<string, DatabaseTone>;
};

export const ToneZod = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    promptTemplate: z.string(),
    isSystem: z.boolean(),
    createdAt: z.number(),
    sortOrder: z.number(),
    isGlobal: z.boolean().optional(),
    isDeprecated: z.boolean().optional(),
    shouldDisablePostProcessing: z.boolean().optional(),
    systemPromptTemplate: z.string().optional(),
    isTemplateTone: z.boolean().optional(),
    category: z.string().optional(),
    outputLength: z.string().optional(),
    exampleInputOutput: z.string().optional(),
  })
  .strict() satisfies z.ZodType<Tone>;
