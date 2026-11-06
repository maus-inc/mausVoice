import { describe, expect, it } from "vitest";

import {
  azureOpenAIGenerateText,
  isAzureJsonObjectOnlyModel,
} from "./azure-openai.utils";

/**
 * On the Azure path the token cap and the response shape must be ONE decision.
 *
 * `AZURE_JSON_OBJECT_ONLY_MODELS` starts from `OPENAI_LEGACY_CHAT_MODELS` and then adds
 * Azure's own spellings, so it is a strict superset of the set the OpenAI endpoint uses. The
 * Azure request once sent `max_completion_tokens` unconditionally while choosing
 * `response_format: json_object` from that superset — so every deployment it had just
 * identified as legacy was sent the field this branch's own helper exists to keep away from
 * it. Wiring the helper in was not enough either: with the OpenAI predicate, `gpt-35-turbo`,
 * `llama-3` and `gpt-4-1106` still disagreed, because they are in the Azure set and not the
 * OpenAI one.
 *
 * So the assertion is the agreement itself rather than a list of expected bodies: for every
 * deployment the classifier calls legacy, the request must cap with `max_tokens`, and for
 * every one it does not, with `max_completion_tokens`. That holds for a deployment added to
 * either set later without this file being edited.
 */
const requestBodyFor = async (
  deploymentName: string,
): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const customFetch = async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  await azureOpenAIGenerateText({
    apiKey: "azure-test-key",
    endpoint: "https://example.openai.azure.com",
    deploymentName,
    prompt: "hi",
    jsonResponse: true,
    customFetch,
  } as never).catch(() => undefined);
  return body;
};

describe("azureOpenAIGenerateText caps with the field its response format implies", () => {
  // A deployment chosen because it is in the Azure set by a route other than the shared
  // OpenAI list: the `gpt-35-turbo` spelling, an open-model prefix, a frozen snapshot, and a
  // case-folded alias. The OpenAI predicate misses all four.
  const LEGACY = [
    "gpt-4",
    "gpt-4-turbo",
    "gpt-35-turbo",
    "llama-3",
    "gpt-4-1106",
    "GPT-4-TURBO",
  ];
  const CURRENT = ["gpt-4o-mini", "gpt-4.1", "o3-mini"];

  it.each(LEGACY)("%s caps with max_tokens", async (deploymentName) => {
    expect(isAzureJsonObjectOnlyModel(deploymentName)).toBe(true);
    const body = await requestBodyFor(deploymentName);
    expect(
      body.max_tokens,
      "legacy deployment must not be capped with the new field",
    ).toBe(1024);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it.each(CURRENT)(
    "%s caps with max_completion_tokens",
    async (deploymentName) => {
      expect(isAzureJsonObjectOnlyModel(deploymentName)).toBe(false);
      const body = await requestBodyFor(deploymentName);
      expect(body.max_completion_tokens).toBe(1024);
      expect(body.max_tokens).toBeUndefined();
    },
  );
});
