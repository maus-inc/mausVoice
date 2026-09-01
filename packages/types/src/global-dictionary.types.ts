import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import { Replace } from "./common.types";

export type DatabaseGlobalDictionary = {
  id: string;
  tenantId: string;
  terms: string[];
  createdAt: FiremixTimestamp;
  updatedAt: FiremixTimestamp;
};

export type GlobalDictionary = Replace<
  DatabaseGlobalDictionary,
  FiremixTimestamp,
  string
>;

export const GlobalDictionaryZod = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    terms: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict() satisfies z.ZodType<GlobalDictionary>;
