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

const awaitWithAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal | null,
): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) throw signal.reason;

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
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

  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : Array.from(new Uint8Array(await request.arrayBuffer()));
  const operation = invoke<PrivateHttpResponse>("private_http_request", {
    request: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    },
  });
  const response = await awaitWithAbort(operation, request.signal);
  return new Response(responseBytes(response.body), {
    status: response.status,
    headers: response.headers,
  });
};
