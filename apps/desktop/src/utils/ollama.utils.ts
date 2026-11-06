import { secureFetch as fetch } from "./secure-fetch.utils";
import { discardResponseBody } from "@maus-inc/utilities";

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

export const getOllamaHeaders = (apiKey?: string): HeadersInit =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

export type OllamaTestIntegrationArgs = {
  baseUrl?: string;
  apiKey?: string;
};

export const ollamaTestIntegration = async ({
  baseUrl = OLLAMA_DEFAULT_URL,
  apiKey,
}: OllamaTestIntegrationArgs): Promise<boolean> => {
  const headers = getOllamaHeaders(apiKey);

  let response: Response;
  try {
    response = await fetch(baseUrl, { headers });
  } catch {
    // A configured endpoint or transport error can contain credentials. Keep
    // the actionable diagnosis without echoing either into the UI or logs.
    throw new Error(
      "Unable to connect to Ollama. Make sure Ollama is running.",
    );
  }

  discardResponseBody(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Ollama authentication failed. Check your API key. Code: ${response.status}`,
      );
    }

    throw new Error(
      `Ollama returned an error (status ${response.status}). Check your configuration.`,
    );
  }

  return true;
};
