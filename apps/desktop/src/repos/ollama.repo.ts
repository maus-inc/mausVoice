import { secureFetch as fetch } from "../utils/secure-fetch.utils";
import { getOllamaHeaders } from "../utils/ollama.utils";
import { appendOpenAICompatiblePath } from "../utils/openai-compatible.utils";
import { BaseRepo } from "./base.repo";

export abstract class BaseOllamaRepo extends BaseRepo {
  // `signal` is optional so existing callers are unaffected, but the pickers need it:
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
      const health = await fetch(`${this.ollamaUrl}`, {
        headers: getOllamaHeaders(this.apiKey),
        signal,
      });
      return health.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(new URL("/api/tags", this.ollamaUrl).href, {
      headers: getOllamaHeaders(this.apiKey),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Unable to fetch Ollama models (status ${response.status})`,
      );
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };

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
      const health = await this.fetchFn(
        appendOpenAICompatiblePath(this.baseUrl, "models"),
        {
          headers: getOllamaHeaders(this.apiKey),
          signal,
        },
      );
      return health.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetchFn(
      appendOpenAICompatiblePath(this.baseUrl, "models"),
      {
        headers: getOllamaHeaders(this.apiKey),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Unable to fetch models (status ${response.status})`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    if (!payload.data) {
      return [];
    }

    return payload.data
      .map((model) => (model.id ?? "").trim())
      .filter((name): name is string => Boolean(name));
  }
}
