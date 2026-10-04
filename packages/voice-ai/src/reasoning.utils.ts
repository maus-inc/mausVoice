/**
 * Reasoning controls for the non-streaming generate-text flows (dictation
 * post-processing, style preview, and composer edit mode). Every caller of
 * `BaseGenerateTextRepo.generateText` is a short text transform: the model
 * receives a transcript plus instructions and returns one rewritten result.
 *
 * GPT-OSS models on Groq and Cerebras return a separate reasoning channel
 * whose tokens count toward the completion budget and the rate limit. Both
 * providers default that channel to `medium` effort, which spends latency and
 * quota on thinking that a rewrite does not need:
 *
 * - Groq documents `reasoning_effort` as `low | medium | high` for GPT-OSS,
 *   with no "off", and recommends low effort for simple transforms.
 *   https://console.groq.com/docs/reasoning
 * - Cerebras documents the same values for `gpt-oss-120b` (default `medium`)
 *   and states that reasoning tokens count toward `max_completion_tokens`.
 *   https://inference-docs.cerebras.ai/capabilities/reasoning
 *
 * `reasoning_format: "hidden"` keeps the reasoning text out of the response
 * content. Groq requires `parsed` or `hidden` whenever JSON mode or tool use
 * is enabled and rejects `raw` there with a 400, so the hidden format is the
 * only one that is safe for every generate-text call.
 *
 * The controls are model-gated because both providers reject unknown
 * parameters for models that do not support them: Cerebras `gemma-4-31b` does
 * not support `reasoning_format` at all, and `qwen-3.8-27b` does not support
 * the hidden format. Sending the pair unconditionally would turn a working
 * request into a 400 for those models.
 *
 * Gemini does not use reasoning tokens on the completion channel; it publishes
 * a separate thinking budget that is also charged against the output limit:
 *
 * - Gemini 3 models default to `medium` thinking (`high` on the Pro previews)
 *   and take `thinkingLevel`, where `low` is the lowest accepted level on the
 *   Flash and Pro models used here (`minimal` is rejected by 3.7 Flash).
 *   https://ai.google.dev/gemini-api/docs/generate-content/thinking
 * - Gemini 2.5 models take `thinkingBudget`, and `0` disables thinking.
 *
 * A 600-token post-processing budget is smaller than a default thinking pass,
 * so the JSON never gets written and the flow falls back to the raw
 * transcript. The same model gating applies: an unsupported field fails the
 * whole request, so unflagged models keep the provider default.
 */

const GENERATE_TEXT_REASONING_EFFORT = "low" as const;

type GptOssReasoningParams = {
  reasoning_effort?: typeof GENERATE_TEXT_REASONING_EFFORT;
  reasoning_format?: "hidden";
};

/**
 * Matches the GPT-OSS id shape used by both providers, with or without a
 * vendor prefix (`gpt-oss-120b` on Cerebras, `openai/gpt-oss-120b` on Groq).
 * The trailing dash keeps the family prefix from matching on its own:
 * suffixed ids such as `openai/gpt-oss-safeguard-20b` are included, while a
 * bare `gpt-oss` (never a published id) falls through to the plain request.
 */
const GPT_OSS_MODEL_ID = /(?:^|\/)gpt-oss-/;

export const isGptOssReasoningModel = (model: string): boolean =>
  GPT_OSS_MODEL_ID.test(model);

export const buildGptOssReasoningParams = (
  model: string,
): GptOssReasoningParams =>
  isGptOssReasoningModel(model)
    ? {
        reasoning_effort: GENERATE_TEXT_REASONING_EFFORT,
        reasoning_format: "hidden",
      }
    : {};

/**
 * The `thinkingConfig` entry for a Gemini `generationConfig`, or null when the
 * model keeps its own default. Flash-Lite models already default to `minimal`,
 * the lowest level, so lowering them to `low` would only add thinking.
 */
export const buildGeminiThinkingConfig = (
  model: string,
): Record<string, unknown> | null => {
  const id = model.replace(/^models\//, "");

  if (/^gemini-2\.5-.*flash/.test(id)) {
    return { thinkingBudget: 0 };
  }

  if (
    id.startsWith("gemini-3") &&
    !id.includes("flash-lite") &&
    !id.includes("image")
  ) {
    return { thinkingLevel: "low" };
  }

  return null;
};
