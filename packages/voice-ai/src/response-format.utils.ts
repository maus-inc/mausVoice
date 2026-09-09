import type { JsonResponse } from "@maus-inc/types";

/**
 * Bare OpenAI chat model ids that predate Structured Outputs and reject
 * `response_format: { type: "json_schema" }` (400 from the API). Providers
 * key their own id spaces off this list (OpenRouter prefixes "openai/",
 * Azure uses deployment names), so the canonical ids live here.
 */
export const OPENAI_LEGACY_CHAT_MODELS = [
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-1106",
  "gpt-4",
  "gpt-4-0301",
  "gpt-4-0613",
  "gpt-4-32k",
  "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-1106-preview",
  "gpt-4-0125-preview",
] as const;

/**
 * Builds the `response_format` for a JSON-mode generation request.
 *
 * `json_object` is sent ONLY for the legacy models named in
 * `jsonObjectOnlyModels` (pre-Structured-Outputs chat models such as
 * gpt-3.5-turbo / gpt-4-turbo, which reject `json_schema` with a 400).
 * Every other model — including discovered/unknown modern models (gpt-4o
 * 2024-08-06+, gpt-4.1, the o-series, gpt-5, gpt-oss) — defaults to
 * `json_schema`: the o-series in particular rejects `json_object`
 * outright, so falling back to it for unknown models is the wrong
 * direction. Callers using the `json_object` branch MUST also inject the
 * word "JSON" into the prompt (see buildJsonObjectPrompt): the OpenAI API
 * errors when it is missing.
 */
export const buildJsonSchemaResponseFormat = (
  model: string,
  isJsonObjectOnlyModel: (model: string) => boolean,
  jsonResponse?: JsonResponse,
) => {
  if (!jsonResponse) return undefined;
  if (isJsonObjectOnlyModel(model)) {
    return { type: "json_object" as const };
  }
  return {
    type: "json_schema" as const,
    json_schema: {
      name: jsonResponse.name,
      description: jsonResponse.description,
      schema: jsonResponse.schema,
      strict: true,
    },
  };
};
