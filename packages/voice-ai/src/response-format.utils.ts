import type { JsonResponse } from "@maus-inc/types";

export const buildJsonSchemaResponseFormat = (
  model: string,
  supportedModels: ReadonlySet<string>,
  jsonResponse?: JsonResponse,
) => {
  if (!jsonResponse) return undefined;
  if (!supportedModels.has(model)) {
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
