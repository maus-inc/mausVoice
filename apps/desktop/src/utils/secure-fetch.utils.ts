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
  // `apiKeyId` is required by the Rust `openai_compatible_http_request`
  // command; omitting it causes Tauri to reject the invocation with a
  // cryptic error that does not surface the validation failure. Always
  // include it when the command expects it.
  if (command === "openai_compatible_http_request" && !apiKeyId) {
    throw new Error("apiKeyId is required for openai_compatible_http_request");
  }
  const payload = {
    request: {
      requestId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    },
    // Tauri command arguments use camelCase at the JavaScript boundary;
    // `apiKeyId` binds the Rust command's `api_key_id` parameter.
    ...(apiKeyId ? { apiKeyId } : {}),
  };
  // Tauri's invoke() rejects with a raw string on serialization or
  // command errors, which erases stack traces and prevents instanceof
  // checks downstream. Wrap the rejection in an Error to preserve the
  // error message while keeping a proper type.
  const operation = invoke<PrivateHttpResponse>(command, payload).catch(
    (error: unknown) => {
      if (error instanceof Error) throw error;
      // String(error) / String(message) on a plain object produces
      // '[object Object]', which is unhelpful. Use the object's own
      // message property when it is a string, or JSON.stringify for
      // a meaningful representation.
      if (error != null && typeof error === "object") {
        const rawMessage = (error as Record<string, unknown>).message;
        const message =
          typeof rawMessage === "string" ? rawMessage : JSON.stringify(error);
        throw new Error(`Tauri IPC error: ${message}`);
      }
      // `error` is a primitive (string, number, boolean) or null/undefined.
      // Use JSON.stringify to safely stringify any non-string value without
      // producing '[object Object]'. JSON.stringify returns `undefined` for
      // `undefined`, so fall back to a default message.
      const errorText =
        typeof error === "string"
          ? error
          : (JSON.stringify(error) ?? "Unknown Tauri IPC error");
      throw new Error(errorText);
    },
  );
  const response = await awaitWithAbort(operation, request.signal, () => {
    void invoke<boolean>("cancel_private_http_request", { requestId }).catch(
      () => undefined,
    );
  });
  // 204 No Content, 205 Reset Content, and 304 Not Modified are null-body
  // statuses: passing a body (even an empty Uint8Array) to the Response
  // constructor throws a TypeError. Use a null body for these statuses.
  const NULL_BODY_STATUSES = new Set([204, 205, 304]);
  const responseBody = NULL_BODY_STATUSES.has(response.status)
    ? null
    : responseBytes(response.body);
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers,
  });
};

/**
 * Fetch through the plugin for curated HTTPS providers, but route plaintext
 * user-configured endpoints through a Rust command that parses hosts as real IP
 * addresses and accepts only loopback/RFC1918/unique-local/.local targets on
 * every redirect. This avoids treating hostname globs such as `10.*` as CIDR.
 *
 * Uses a positive allow-list for schemes rather than a negative check so
 * that unsupported future schemes are rejected by default.
 */
export const secureFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(requestUrl(input));
  if (url.protocol === "http:") {
    return invokeHttpRequest("private_http_request", input, init);
  }
  if (url.protocol === "https:") {
    return tauriFetch(input, init);
  }
  // Reject unsupported schemes (e.g. file:, data:) rather than forwarding
  // them to plugin-http which may interpret them unexpectedly.
  throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
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
