import { discardResponseBody } from "@maus-inc/utilities";
import {
  fetchModelResponse,
  parseModelResponse,
} from "../utils/model-discovery.utils";
import { resolveServiceUrl } from "../utils/service-url.utils";
import { secureFetch as fetch } from "../utils/secure-fetch.utils";
import { getOllamaHeaders } from "../utils/ollama.utils";
import { appendOpenAICompatiblePath } from "../utils/openai-compatible.utils";
import { BaseRepo } from "./base.repo";

/** Shared discovery contract for the two compatible endpoint pickers. */
export abstract class BaseOllamaRepo extends BaseRepo {
  // `signal` is optional so existing callers are unaffected, and both pickers that
  // poll these do pass one -- `OllamaModelPicker` and `OpenAICompatibleModelPicker`
  // each abort on timeout and on unmount, with a fresh controller per probe so a
  // timeout cannot poison later retries. The reason they need it:
  // a probe bounded by `withTimeout` stops WAITING on a stalled host, it does not stop the
  // request, so without an abort every retry left another live fetch behind.
  abstract checkAvailability(signal?: AbortSignal): Promise<boolean>;
  abstract getAvailableModels(signal?: AbortSignal): Promise<string[]>;
}

export class OllamaRepo extends BaseOllamaRepo {
  private ollamaUrl: string;
  private apiKey?: string;

  constructor(ollamaUrl: string, apiKey?: string) {
    super();
    this.ollamaUrl = ollamaUrl;
    this.apiKey = apiKey;
  }

  override async checkAvailability(signal?: AbortSignal): Promise<boolean> {
    try {
      const health = await fetchModelResponse("Ollama", fetch, this.ollamaUrl, {
        headers: getOllamaHeaders(this.apiKey),
        signal,
      });
      discardResponseBody(health);
      return health.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    const url = resolveServiceUrl(this.ollamaUrl, "/api/tags");
    const response = await fetchModelResponse("Ollama", fetch, url, {
      headers: getOllamaHeaders(this.apiKey),
      signal,
    });
    if (!response.ok) {
      discardResponseBody(response);
      throw new Error(
        `Unable to fetch Ollama models (status ${response.status})`,
      );
    }

    const payload = await parseModelResponse<{
      models?: Array<{ name?: string }>;
    }>("Ollama", response, signal);

    if (!payload.models) {
      return [];
    }

    return payload.models
      .map((model) => (model.name ?? "").trim())
      .filter((name): name is string => Boolean(name));
  }
}

export class OpenAICompatibleRepo extends BaseOllamaRepo {
  private baseUrl: string;
  private apiKey?: string;
  private fetchFn: typeof fetch;

  constructor(
    baseUrl: string,
    apiKey?: string,
    customFetch: typeof fetch = fetch,
  ) {
    super();
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchFn = customFetch;
  }

  override async checkAvailability(signal?: AbortSignal): Promise<boolean> {
    try {
      const health = await fetchModelResponse(
        "OpenAI-compatible",
        this.fetchFn,
        appendOpenAICompatiblePath(this.baseUrl, "models"),
        {
          headers: getOllamaHeaders(this.apiKey),
          signal,
        },
      );
      discardResponseBody(health);
      return health.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetchModelResponse(
      "OpenAI-compatible",
      this.fetchFn,
      appendOpenAICompatiblePath(this.baseUrl, "models"),
      { headers: getOllamaHeaders(this.apiKey), signal },
    );
    if (!response.ok) {
      discardResponseBody(response);
      throw new Error(`Unable to fetch models (status ${response.status})`);
    }

    const payload = await parseModelResponse<{
      data?: Array<{ id?: string }>;
    }>("OpenAI-compatible", response, signal);

    if (!payload.data) {
      return [];
    }

    return payload.data
      .map((model) => (model.id ?? "").trim())
      .filter((name): name is string => Boolean(name));
  }
}
