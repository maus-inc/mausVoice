import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

type PrivateHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

const getIpcErrorMessage = (error: object): string => {
  // Tauri normally rejects with an Error or a plain serialised object. Read
  // only a data-property message so an unexpected getter cannot run while we
  // are already handling an IPC failure.
  try {
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    if (typeof message === "string") return message;
    return JSON.stringify(error) ?? "Unknown Tauri IPC error";
  } catch {
    // A hostile or otherwise unserialisable object must not hide the original
    // request failure behind a second exception from error formatting.
    return "Unknown Tauri IPC error";
  }
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
};

// Keep each btoa input below engine argument/string limits. The chunk is a
// multiple of three so padding only appears at the end of the full payload.
const BASE64_INPUT_CHUNK_BYTES = 24 * 1024;
// Keep the renderer-side preflight aligned with the native command. The native
// limit remains authoritative, but reading a body with Request.arrayBuffer()
// first meant a malformed local caller could allocate an unbounded duplicate
// in the webview before the command had a chance to reject it.
const MAX_PRIVATE_HTTP_REQUEST_BYTES = 128 * 1024 * 1024;

const privateHttpRequestLimitError = (): RangeError =>
  new RangeError("Private-network request body exceeds the 128 MiB limit");

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const bytesToBase64 = (bytes: Uint8Array): string => {
  const encodedChunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_INPUT_CHUNK_BYTES
  ) {
    const chunk = bytes.subarray(offset, offset + BASE64_INPUT_CHUNK_BYTES);
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encodedChunks.push(btoa(binary));
  }
  return encodedChunks.join("");
};

const readBodyChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | null,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  if (!signal) return reader.read();
  if (signal.aborted) throw abortReason(signal);

  const pending = reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", abort);
      return true;
    };
    const abort = () => {
      // A body-read rejection after this user-visible AbortError is already
      // handled by `pending.then` below. The outer encoder cancels the reader
      // in its failure cleanup, after this promise leaves the loop.
      if (finish()) reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => {
        if (finish()) resolve(result);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
    // Abort may have happened in the tiny interval before the listener was
    // registered. Checking again ties this read to the signal without a timer.
    if (signal.aborted) abort();
  });
};

/**
 * Read a request body incrementally, enforcing the native command's decoded
 * byte cap before Base64 transport framing. Carrying the last zero to two
 * bytes across stream chunks makes the joined frames one valid RFC 4648 value
 * rather than padding every source chunk independently.
 */
export const encodePrivateHttpBodyStream = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | null = null,
  maxBytes = MAX_PRIVATE_HTTP_REQUEST_BYTES,
): Promise<string> => {
  const reader = body?.getReader();
  if (!reader) return "";

  let byteLength = 0;
  let trailing = new Uint8Array(0);
  const encodedChunks: string[] = [];
  let completed = false;

  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw privateHttpRequestLimitError();
      }

      let combined = value;
      if (trailing.byteLength > 0) {
        combined = new Uint8Array(trailing.byteLength + value.byteLength);
        combined.set(trailing);
        combined.set(value, trailing.byteLength);
      }
      const completeLength = combined.byteLength - (combined.byteLength % 3);
      if (completeLength > 0) {
        encodedChunks.push(bytesToBase64(combined.subarray(0, completeLength)));
      }
      // `combined` can be a large stream chunk, so copy the small tail before
      // the next read instead of retaining the whole chunk in memory.
      trailing = combined.subarray(completeLength).slice();
    }
    completed = true;
  } finally {
    if (!completed) {
      // No fetch has begun, so cancellation is cleanup only. Preserve the
      // size/abort/read error that caused this path if the producer rejects
      // cancellation while it is shutting down.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (trailing.byteLength > 0) {
    encodedChunks.push(bytesToBase64(trailing));
  }
  return encodedChunks.join("");
};

const base64ToBytes = (encoded: string): Uint8Array => {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new TypeError("Private-network response body is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

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

// The native bridge validates, caps, and returns the whole body, so SSE/LLM
// streaming over private or saved endpoints resolves in one burst rather than
// token by token. This bridge is used for bounded rewrite and model payloads,
// not the interactive public-provider streaming path.
const invokeHttpRequest = async (
  command: "private_http_request" | "openai_compatible_http_request",
  input: RequestInfo | URL,
  init?: RequestInit,
  apiKeyId?: string,
): Promise<Response> => {
  const request = new Request(input, init);
  const bodyBase64 =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await encodePrivateHttpBodyStream(request.body, request.signal);
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
      bodyBase64,
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
        throw new Error(`Tauri IPC error: ${getIpcErrorMessage(error)}`);
      }
      // `error` is a primitive (string, number, boolean) or null/undefined.
      // JSON.stringify avoids an unhelpful '[object Object]' if a future
      // invocation boundary supplies a non-string value.
      let errorText: string;
      try {
        errorText =
          typeof error === "string"
            ? error
            : (JSON.stringify(error) ?? "Unknown Tauri IPC error");
      } catch {
        errorText = "Unknown Tauri IPC error";
      }
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
    : base64ToBytes(response.bodyBase64);
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
  const raw = requestUrl(input);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // A relative URL (e.g. a saved base of "/v1" joined without an origin)
    // otherwise surfaces as a generic engine "Invalid URL" with no pointer to
    // which egress boundary rejected it. Echo the input start only — a
    // relative string cannot contain credentials the caller didn't supply.
    throw new TypeError(
      `secureFetch requires an absolute http(s) URL, received: ${raw.slice(0, 128)}`,
    );
  }
  if (url.protocol === "http:") {
    return invokeHttpRequest("private_http_request", input, init);
  }
  if (url.protocol === "https:") {
    // HTTPS goes through plugin-http directly. Two layers keep this safe:
    // the Rust side re-checks saved-endpoint URLs and their resolved
    // addresses (including per-redirect-hops in `commands.rs`), and the
    // `http:default` capability is a curated provider allow-list (never
    // `https://*`), enforced by `csp-capability.contract.test.ts`. If the
    // capability ever loosens to a wildcard, routing here must be
    // revisited: user-controlled HTTPS URLs would become an SSRF vector.
    // Residual: when a system proxy routes the request (corporate CONNECT),
    // DNS resolution happens at the proxy rather than under the Rust pin;
    // TLS hostname validation is the binding layer there (see commands.rs).
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
