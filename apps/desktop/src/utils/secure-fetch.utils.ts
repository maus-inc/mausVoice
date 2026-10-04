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

// The Fetch standard's redirect limit, so a hand-walked chain cannot loop.
const MAX_HTTPS_REDIRECTS = 20;

// The Fetch standard deletes these from the header list when a redirect leaves
// the origin the request was issued to (the "CORS non-wildcard request-header
// name" list, plus the cookie header). `Authorization` is the one callers rely
// on: `secureFetch` is typed as `typeof globalThis.fetch`, so a caller that
// passes a bearer token is entitled to the standard's cross-origin strip.
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie"];
// Headers that describe a body. A 301/302/303 rewrite discards the body, and a
// Content-Type or Content-Length that outlives it describes a request that is
// no longer being sent.
const BODY_HEADERS = ["content-length", "content-type"];

/** The caller's headers for hop one, whether they arrived as `init` or on a Request. */
const requestHeaders = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers => {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headers;
};

/** The caller's method for hop one; `init` wins over a Request, as in `fetch`. */
const requestMethod = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string => init?.method ?? (input instanceof Request ? input.method : "GET");

/**
 * The statuses the Fetch standard treats as redirects. Membership is by list
 * rather than by range because the range includes statuses that are not
 * redirects: a 304 revalidates a cached response and a 305 asks the client to
 * reuse the same URL, and neither one names a request that should be re-issued.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The URL one hop of a redirect chain moves to, or null when this response
 * ends the chain. Throws when a hop leaves HTTPS, because that hop must never
 * be issued and there is no response to return in its place.
 */
const nextHopUrl = (response: Response, currentUrl: URL): URL | null => {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  // A redirect with no Location cannot be followed, so surface it as-is rather
  // than re-issuing the same request against a server that would answer
  // identically.
  if (!location) return null;
  const targetUrl = new URL(location, currentUrl);
  if (targetUrl.protocol !== "https:") {
    throw new TypeError(
      `Refusing redirect from HTTPS to insecure protocol: ${targetUrl.protocol}`,
    );
  }
  return targetUrl;
};

/** What one hop of a redirect chain is asked to send. */
type RedirectHop = {
  method: string;
  /** See `followHttpsRedirects` for what `undefined` and `null` mean here. */
  body: BodyInit | null | undefined;
  headers: Headers;
};

/**
 * What the next hop of a redirect chain carries, per the Fetch standard's
 * redirect handling: the headers the standard deletes when a hop leaves the
 * origin the request was issued to, and the method and body it rewrites. The
 * hop's own `Headers` is edited in place, because the chain carries one header
 * list across hops and a returned copy would leave the caller sending a stale
 * one. The two URLs are named rather than positional because which of them the
 * origin is compared against is the whole difference between the strip
 * applying and not.
 */
const rewriteForRedirect = (
  status: number,
  from: URL,
  to: URL,
  hop: RedirectHop,
): RedirectHop => {
  // Compare against the URL this hop was sent to, so the strip applies from
  // the first hop that changes origin and not from the last.
  if (to.origin !== from.origin) {
    for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
      hop.headers.delete(name);
    }
  }
  // A 301 or 302 downgrades a POST to a GET, and a 303 does the same for every
  // method but GET and HEAD, discarding the body in both cases. 307 and 308
  // keep the method and body by definition.
  const uppercase = hop.method.toUpperCase();
  const downgrades =
    ((status === 301 || status === 302) && uppercase === "POST") ||
    (status === 303 && uppercase !== "GET" && uppercase !== "HEAD");
  if (!downgrades) return hop;
  // A Content-Type or Content-Length that outlives the discarded body
  // describes a request that is no longer being sent.
  for (const name of BODY_HEADERS) hop.headers.delete(name);
  return { ...hop, method: "GET", body: null };
};

/**
 * Walk an HTTPS redirect chain one hop at a time, refusing any hop that leaves
 * HTTPS. The chain has to be walked here rather than handed back to
 * plugin-http: the plugin ignores `RequestInit.redirect` and forwards only
 * `maxRedirections` to reqwest, and its capability scope is checked against
 * the *first* URL only. So every hop asks for zero redirects, which is what
 * makes each hop observable and therefore checkable, and a later
 * HTTPS → HTTP hop is refused instead of replaying the caller's headers —
 * Authorization included — in clear text.
 *
 * Each hop therefore carries its own headers and method rather than the
 * caller's `init` replayed verbatim. The standard rewrites both as a chain is
 * followed, and a hand-walked chain that skipped those rewrites would be the
 * weaker of the two implementations it stands in for.
 */
const followHttpsRedirects = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startUrl: URL,
): Promise<Response> => {
  // Inherited from a `Request` input for the same reason its signal is, further down: a
  // `Request` IS the request, and dropping part of it because the caller spelled it on the
  // object rather than in `init` is the same bug as dropping the signal. `new Request(input,
  // init)` inherits `redirect` whenever `init` omits it.
  const redirectMode =
    init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
  const chain = {
    headers: requestHeaders(input, init),
    method: requestMethod(input, init),
    // `null` means a hop discarded the body; `undefined` means the caller gave
    // none in `init`.
    body: init?.body,
    url: startUrl,
  };
  const requestSignal = input instanceof Request ? input.signal : null;
  // A `Request` input carries its body on the object rather than in `init`, and a
  // URL cannot name one. So hop one is issued against that Request and lets the
  // plugin stream it as it always has; only a redirect needs the bytes spelled
  // out, and only then is the body read (see `walkChain`). Buffering it up front
  // would duplicate every streamed upload in memory to serve a case that mostly
  // never arrives.
  const requestWithBody =
    input instanceof Request && init?.body === undefined && input.body !== null
      ? input
      : null;
  // Clone BEFORE hop 0 goes out, and hand the CLONE to the transport.
  //
  // The plugin does `new Request(input, init)` and then `await req.arrayBuffer()`
  // (plugin-http/dist-js/index.js:66-67). Constructing a `Request` from another `Request`
  // inherits its body stream, and `arrayBuffer()` consumes that stream -- so passing the
  // caller's own object to hop 0 leaves the CALLER's request with `bodyUsed === true`, and
  // the `clone()` in `walkChain` then throws `TypeError: unusable`. Measured:
  //
  //     before hop 0   bodyUsed = false
  //     after  hop 0   bodyUsed = true      clone() -> TypeError: unusable
  //
  // Two clones, not one, and the second is the reason. `clone()` tees rather than consumes,
  // so each is unread until something reads it -- but the transport is GIVEN a Request and
  // consumes that one, so a single clone is spent by hop 0 and the replay has nothing left to
  // clone. With two, the transport spends its own and the replay reads the other, repeatedly:
  //
  //     after the transport   caller=false  forTransport=true  forReplay=false
  //     replay 1              {"a":1}
  //     replay 2              {"a":1}
  //
  // Streaming is unaffected: hop one still receives a `Request` for the plugin to stream, not
  // a buffered ArrayBuffer. This only duplicates the body when the caller passed a `Request`
  // carrying one, and a chain that never redirects reads neither.
  const hopOneBody = requestWithBody ? requestWithBody.clone() : null;
  const replayBody = requestWithBody ? requestWithBody.clone() : null;

  // The chain is walked recursively rather than in a loop, because a hop's own
  // body has to be read before the next request goes out and a loop that awaits
  // inside it reads as serialisation nobody chose.
  const walkChain = async (hop: number): Promise<Response> => {
    if (hop > MAX_HTTPS_REDIRECTS) {
      // The Fetch standard caps redirect chains at 20 hops; a cycle would
      // otherwise spin here forever.
      throw new TypeError(
        `Refusing to follow more than ${MAX_HTTPS_REDIRECTS} HTTPS redirects`,
      );
    }
    const response = await tauriFetch(
      hop === 0 && hopOneBody ? hopOneBody : chain.url.href,
      {
        ...init,
        method: chain.method,
        headers: chain.headers,
        body: chain.body,
        maxRedirections: 0,
        // A `Request` input's own signal and redirect mode are part of the
        // request; `init` alone would drop them, and an HTTPS request that
        // ignored its abort signal would outlive the screen that started it.
        signal: init?.signal ?? requestSignal ?? undefined,
      },
    );
    const targetUrl = nextHopUrl(response, chain.url);
    if (!targetUrl) return response;

    // The caller's redirect mode is decided here rather than handed to the
    // plugin, which drops `RequestInit.redirect`. `manual` hands the redirect
    // response back so the caller can read `Location` itself; `error` refuses
    // it. Both used to be forwarded to a plugin that ignored them, so a caller
    // asking for `redirect: "error"` silently got follow behaviour instead.
    //
    // No shipped caller asks for either mode today -- every `redirect:` in this
    // repository is in a test or goes to the bare global `fetch`. An earlier
    // version of this comment cited `gladia.utils.ts` as a caller that needed
    // this, but that file passes `redirect: "error"` to the engine's own `fetch`
    // and never reaches here, so it was evidence for nothing. The mode is honoured
    // because `fetch` promises it, not because a caller was observed needing it.
    if (redirectMode === "manual") return response;
    if (redirectMode === "error") {
      throw new TypeError(
        `Redirect not allowed: ${response.status} from ${chain.url.href} to ${targetUrl.href}`,
      );
    }

    const from = chain.url;
    const next = rewriteForRedirect(response.status, from, targetUrl, {
      method: chain.method,
      body: chain.body,
      headers: chain.headers,
    });
    // `undefined` on both sides means this hop kept the body, which is what a
    // 307 or 308 does and what a downgrading 301/302/303 does not.
    //
    // Read from `replayBody`, never from `requestWithBody`. By this point the transport
    // has consumed whatever it was handed, so the caller's own Request is spent and
    // cloning it throws. `replayBody` was cloned before hop 0 and the transport was given a
    // different clone, so it is still unread here -- and it is cloned again rather than
    // read, because a second 307 in the same chain needs the bytes a second time.
    if (next.body === undefined && chain.body === undefined && replayBody) {
      next.body = await replayBody.clone().arrayBuffer();
    }
    chain.method = next.method;
    chain.body = next.body;
    chain.url = targetUrl;
    return walkChain(hop + 1);
  };

  return walkChain(0);
};

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
    for (const byte of chunk) binary += String.fromCodePoint(byte);
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

// The decoder allocates an owned ArrayBuffer, never a SharedArrayBuffer.
const base64ToBytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new TypeError("Private-network response body is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
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
    // `https://*`), enforced by `csp-capability.contract.test.ts`.
    // Redirects are explicitly confined so they cannot downgrade from HTTPS
    // to an insecure protocol or arbitrary non-HTTPS scheme.
    // All three redirect modes go through the hand-walked chain. The `manual`
    // and `error` branches that used to sit here forwarded the mode to
    // plugin-http, which ignores `RequestInit.redirect` and forwards only
    // `maxRedirections` — so the mode was inert and a caller who asked not to
    // follow redirects got them followed. `followHttpsRedirects` enforces the
    // mode itself, so there is no path here that can only look correct.
    return followHttpsRedirects(input, init, url);
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
