import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

type PrivateHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[] | Uint8Array | ArrayBuffer;
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
};

const responseBytes = (
  body: number[] | Uint8Array | ArrayBuffer,
): Uint8Array => {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  return Uint8Array.from(body);
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const awaitWithAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal | null,
  onAbort: () => void,
): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort();
    throw abortReason(signal);
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
};

const invokeHttpRequest = async (
  command: "private_http_request" | "openai_compatible_http_request",
  input: RequestInfo | URL,
  init?: RequestInit,
  apiKeyId?: string,
): Promise<Response> => {
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : Array.from(new Uint8Array(await request.arrayBuffer()));
  if (request.signal.aborted) throw abortReason(request.signal);

  const requestId = crypto.randomUUID();
  const payload = {
    request: {
      requestId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    },
    ...(apiKeyId ? { apiKeyId } : {}),
  };
  const operation = invoke<PrivateHttpResponse>(command, payload);
  const response = await awaitWithAbort(operation, request.signal, () => {
    void invoke<boolean>("cancel_private_http_request", { requestId }).catch(
      () => undefined,
    );
  });
  return new Response(responseBytes(response.body), {
    status: response.status,
    headers: response.headers,
  });
};

/**
 * Fetch through the plugin for curated HTTPS providers, but route plaintext
 * user-configured endpoints through a Rust command that parses hosts as real IP
 * addresses and accepts only loopback/RFC1918/unique-local/.local targets on
 * every redirect. This avoids treating hostname globs such as `10.*` as CIDR.
 */
export const secureFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(requestUrl(input));
  if (url.protocol !== "http:") {
    return tauriFetch(input, init);
  }
  return invokeHttpRequest("private_http_request", input, init);
};

/**
 * Native fetch for a saved OpenAI-compatible endpoint. Rust authorizes every
 * request and redirect against this API-key record's saved base URL, allowing
 * user-selected HTTPS hosts without weakening CSP or plugin-http to https://*.
 */
export const createOpenAICompatibleFetch =
  (apiKeyId: string): typeof globalThis.fetch =>
  (input, init) =>
    invokeHttpRequest("openai_compatible_http_request", input, init, apiKeyId);
