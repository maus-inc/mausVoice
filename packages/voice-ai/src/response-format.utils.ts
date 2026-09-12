import type { JsonResponse } from "@maus-inc/types";

/**
 * Bare OpenAI chat model ids that predate Structured Outputs and reject
 * `response_format: { type: "json_schema" }` (400 from the API).
 *
 * Structured Outputs only exists on gpt-4o-mini / gpt-4o-2024-08-06 and
 * later (OpenAI structured-outputs guide); every chat model released
 * before that — the GPT-3.5-Turbo family and the pre-turbo GPT-4 line,
 * including the frozen preview snapshots — must receive the legacy
 * `json_object` shape instead.
 *
 * Every entry below is a real model id from the OpenAI catalog or
 * deprecation list (e.g. "gpt-4-0314", not "gpt-4-0301", which is the id
 * from the March 2023 launch announcement).
 *
 * Providers key their own id spaces off this list (OpenRouter prefixes
 * "openai/", Azure derives deployment names from it), so the canonical
 * ids live here and the provider sets are DERIVED from this single
 * source — they cannot drift apart.
 */
export const OPENAI_LEGACY_CHAT_MODELS = [
  // GPT-3.5-Turbo family
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-0301",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-1106",
  "gpt-3.5-turbo-16k",
  "gpt-3.5-turbo-16k-0613",
  "gpt-3.5-turbo-instruct",
  // GPT-4 family (pre-Structured-Outputs)
  "gpt-4",
  "gpt-4-0314",
  "gpt-4-0613",
  "gpt-4-32k",
  "gpt-4-32k-0314",
  "gpt-4-32k-0613",
  "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-turbo-preview",
  "gpt-4-1106-preview",
  "gpt-4-0125-preview",
  "gpt-4-vision-preview",
  "gpt-4-1106-vision-preview",
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
