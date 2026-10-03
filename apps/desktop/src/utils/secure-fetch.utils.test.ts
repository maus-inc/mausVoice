import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, pluginFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pluginFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetchMock }));

import {
  createOpenAICompatibleFetch,
  encodePrivateHttpBodyStream,
  secureFetch,
} from "./secure-fetch.utils";

const encodeBase64 = (text: string): string => btoa(text);

const decodeBase64 = (encoded: string): string => atob(encoded);

const streamFromChunks = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/**
 * One hop as plugin-http was asked to send it. The headers are copied at call
 * time rather than held by reference, because a chain strips credentials from a
 * single Headers object as it walks: a reference read after the chain finished
 * would report the last hop's state for every hop in it.
 */
type Hop = {
  url: string;
  method?: string;
  body?: unknown;
  headers: Record<string, string>;
};

/** The hops the `serveHops` helper recorded for the request under test. */
let hops: Hop[] = [];

describe("secureFetch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    pluginFetchMock.mockReset();
    hops = [];
  });

  /** Answer each hop in turn and record what it was asked to send. */
  const serveHops = (responses: readonly Response[]): void => {
    const queue = [...responses];
    pluginFetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      hops.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
        headers,
      });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected hop to ${String(input)}`);
      return Promise.resolve(next);
    });
  };

  const hop = (index: number): Hop => {
    const recorded = hops[index];
    expect(recorded, `hop ${index} must have been requested`).toBeDefined();
    return recorded as Hop;
  };

  it("frames chunks separated at non-Base64 boundaries as one body", async () => {
    const original = Uint8Array.from([0, 1, 2, 253, 254, 255, 17]);

    const encoded = await encodePrivateHttpBodyStream(
      streamFromChunks([
        original.subarray(0, 2),
        original.subarray(2, 5),
        original.subarray(5),
      ]),
    );

    const decoded = decodeBase64(encoded);
    expect(
      Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    ).toEqual(original);
  });

  it("rejects an oversized stream before it is Base64-framed", async () => {
    await expect(
      encodePrivateHttpBodyStream(
        streamFromChunks([Uint8Array.from([0, 1]), Uint8Array.from([2, 3])]),
        null,
        3,
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("stops a pending body read when its request is aborted", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const controller = new AbortController();
    const pending = encodePrivateHttpBodyStream(body, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toBe(true);
  });

  it("keeps curated HTTPS requests in plugin-http", async () => {
    const expected = new Response("ok");
    pluginFetchMock.mockResolvedValue(expected);

    await expect(secureFetch("https://api.openai.com/v1/models")).resolves.toBe(
      expected,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a later redirect hop that downgrades HTTPS to plain HTTP", async () => {
    pluginFetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://api.openai.com/v1/hop-2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://attacker.example/collect" },
        }),
      );

    await expect(
      secureFetch("https://api.openai.com/v1/models", {
        headers: { Authorization: "Bearer secret" },
      }),
    ).rejects.toThrow(
      "Refusing redirect from HTTPS to insecure protocol: http:",
    );
    // Two hops were requested, not one: the downgrade hid behind the second
    // hop, so a fix that only validated the first redirect still fails here.
    expect(pluginFetchMock).toHaveBeenCalledTimes(2);
  });

  // The caller's redirect mode has to be enforced by the hand-walked chain.
  // It used to be forwarded to plugin-http, which ignores `RequestInit.redirect`
  // and forwards only `maxRedirections` to reqwest -- so `error` and `manual`
  // were inert and a caller asking not to follow redirects got them followed.
  it("refuses a redirect the caller asked not to follow", async () => {
    pluginFetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
    );

    await expect(
      secureFetch("https://api.openai.com/v1/models", { redirect: "error" }),
    ).rejects.toThrow(/Redirect not allowed: 302/);
    // One hop, not two: the whole point is that the chain was not walked.
    expect(pluginFetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands a redirect back to the caller who asked to handle it", async () => {
    pluginFetchMock.mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.openai.com/v1/moved" },
      }),
    );

    const response = await secureFetch("https://api.openai.com/v1/models", {
      redirect: "manual",
    });

    // `manual` is only useful if the caller can still see where it was sent.
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://api.openai.com/v1/moved",
    );
    expect(pluginFetchMock).toHaveBeenCalledTimes(1);
  });

  // The positive control. Without it the two above would also pass if `error`
  // and `manual` were treated exactly like `follow` and the walker simply threw
  // on every response, so this is what makes them mean what they say.
  it("still follows a redirect when the caller asks to follow it", async () => {
    pluginFetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://api.openai.com/v1/hop-2" },
        }),
      )
      .mockResolvedValueOnce(new Response("followed"));

    const response = await secureFetch("https://api.openai.com/v1/models", {
      redirect: "follow",
    });

    expect(await response.text()).toBe("followed");
    expect(pluginFetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks plugin-http to follow no redirects itself on every hop", async () => {
    pluginFetchMock.mockResolvedValue(new Response("ok"));

    await secureFetch("https://api.openai.com/v1/models");

    // plugin-http ignores RequestInit.redirect and forwards only
    // maxRedirections to reqwest, so a hop is only observable — and therefore
    // only checkable — when that value is 0.
    expect(
      pluginFetchMock.mock.calls.map(([, options]) => options?.maxRedirections),
    ).toEqual([0]);
  });

  it("follows every hop of an all-HTTPS chain instead of returning hop one", async () => {
    pluginFetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://api.openai.com/v1/hop-2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://api.openai.com/v1/hop-3" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));

    const response = await secureFetch("https://api.openai.com/v1/models");

    expect(await response.text()).toBe("ok");
    expect(pluginFetchMock.mock.calls.map(([input]) => input)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/hop-2",
      "https://api.openai.com/v1/hop-3",
    ]);
  });

  it("stops a redirect cycle instead of following it without bound", async () => {
    pluginFetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1/loop" },
      }),
    );

    await expect(
      secureFetch("https://api.openai.com/v1/models"),
    ).rejects.toThrow(/redirect/i);
    expect(pluginFetchMock.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it("drops the credential when a redirect hop crosses origins", async () => {
    // The Fetch standard deletes `Authorization` when a redirect leaves the
    // origin the request was issued to, and `secureFetch` is declared as
    // `typeof globalThis.fetch`, so a caller passing a bearer token relies on
    // that. Replaying the caller's headers on the hop would hand the token to
    // whatever host the first response chose.
    serveHops([
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "x-request-id": "req-1",
      },
    });

    expect(hop(0).headers).toMatchObject({ authorization: "Bearer secret" });
    const second = hop(1);
    expect(second.url).toBe("https://attacker.example/collect");
    expect(second.headers).not.toHaveProperty("authorization");
    expect(second.headers).not.toHaveProperty("cookie");
    // Only the credentials that identify the caller to that origin go.
    expect(second.headers["x-request-id"]).toBe("req-1");
  });

  it("keeps the credential on a redirect hop that stays on the same origin", async () => {
    // The rule is origin-scoped, not a blanket strip: a provider redirecting
    // between its own paths must not force the caller to re-authenticate.
    serveHops([
      new Response(null, {
        status: 307,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer secret" },
    });

    expect(hop(1).headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("turns a 302 POST into a bodyless GET instead of replaying the body", async () => {
    // The standard downgrades a POST to a GET and drops its body on 301, 302
    // and 303. Replaying it unchanged re-sends a request the origin has already
    // said it will not accept.
    serveHops([
      new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });

    expect(hop(1).method).toBe("GET");
    expect(hop(1).body ?? null).toBeNull();
    // A Content-Type describing a body that is no longer sent misleads the next
    // server about the request.
    expect(hop(1).headers).not.toHaveProperty("content-type");
  });

  it("replays the method and body unchanged on a 307", async () => {
    // 307/308 are the explicit "same method, same body" redirect statuses, so
    // the rewrite above must not touch them.
    serveHops([
      new Response(null, {
        status: 307,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });

    expect(hop(1).method).toBe("POST");
    expect(hop(1).body).toBe('{"model":"gpt-4o"}');
    expect(hop(1).headers["content-type"]).toBe("application/json");
  });

  it.each([301, 302])(
    "downgrades a POST to a bodyless GET on a %i as well",
    async (status) => {
      // Both statuses rewrite a POST, and the rule that does it is shared, so
      // a fix that only recognised one of them would rewrite the chain the
      // other way.
      serveHops([
        new Response(null, {
          status,
          headers: { location: "https://api.openai.com/v1/hop-2" },
        }),
        new Response("ok"),
      ]);

      await secureFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-4o"}',
      });

      expect(hop(1).method).toBe("GET");
      expect(hop(1).body ?? null).toBeNull();
      expect(hop(1).headers).not.toHaveProperty("content-type");
    },
  );

  it("keeps a method the 301 or 302 rule does not rewrite", async () => {
    // Only a POST is downgraded by 301 and 302. A PUT is a request the origin
    // answered with a redirect, not one it refused, so it has to survive.
    serveHops([
      new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/threads/abc/runs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"name":"run"}',
    });

    expect(hop(1).method).toBe("PUT");
    expect(hop(1).body).toBe('{"name":"run"}');
    expect(hop(1).headers["content-type"]).toBe("application/json");
  });

  it.each(["POST", "DELETE"])(
    "downgrades a %s to a bodyless GET on a 303",
    async (method) => {
      // 303 downgrades every method but GET and HEAD, so the 301/302 rule alone
      // would replay a DELETE the origin has already answered with a redirect.
      serveHops([
        new Response(null, {
          status: 303,
          headers: { location: "https://api.openai.com/v1/hop-2" },
        }),
        new Response("ok"),
      ]);

      await secureFetch("https://api.openai.com/v1/threads/abc", {
        method,
        headers: { "content-type": "application/json" },
        body: '{"name":"run"}',
      });

      expect(hop(1).method).toBe("GET");
      expect(hop(1).body ?? null).toBeNull();
      expect(hop(1).headers).not.toHaveProperty("content-type");
    },
  );

  it.each(["GET", "HEAD"])("keeps a %s on a 303", async (method) => {
    // The two exceptions the 303 rule names. A GET has no body to discard, and
    // a HEAD is a request for headers, so rewriting either would answer a
    // question the caller did not ask.
    serveHops([
      new Response(null, {
        status: 303,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/models", { method });

    expect(hop(1).method).toBe(method);
  });

  it("replays the method and body unchanged on a 308", async () => {
    serveHops([
      new Response(null, {
        status: 308,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });

    expect(hop(1).method).toBe("POST");
    expect(hop(1).body).toBe('{"model":"gpt-4o"}');
  });

  it("returns a redirect with no Location instead of re-issuing it", async () => {
    // Nothing to follow, and re-issuing the same request against a server that
    // would answer identically only spends the caller's credentials twice.
    const expected = new Response(null, { status: 302 });
    pluginFetchMock.mockResolvedValue(expected);

    await expect(
      secureFetch("https://api.openai.com/v1/models", {
        headers: { Authorization: "Bearer secret" },
      }),
    ).resolves.toBe(expected);
    expect(pluginFetchMock).toHaveBeenCalledTimes(1);
  });

  // The 3xx range is wider than the set of redirects. A 304 is the answer to a
  // conditional request and carries no request to re-issue, so treating every
  // 3xx as a redirect turns a cache hit into an endless revalidation loop
  // whenever a proxy adds a Location header.
  it.each([304, 305, 306])(
    "returns a %s as-is instead of following it as a redirect",
    async (status) => {
      const expected = new Response(null, {
        status,
        headers: { location: "https://api.openai.com/v1/elsewhere" },
      });
      pluginFetchMock.mockResolvedValue(expected);

      await expect(
        secureFetch("https://api.openai.com/v1/models", {
          headers: { Authorization: "Bearer secret" },
        }),
      ).resolves.toBe(expected);
      expect(pluginFetchMock).toHaveBeenCalledTimes(1);
    },
  );

  // A `Request` input carries its body on the object, not in `init`, so a 307
  // that kept the method replayed the next hop with no body at all.
  it("replays a Request input's body on a 307", async () => {
    serveHops([
      new Response(null, {
        status: 307,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    const request = new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });

    await secureFetch(request);

    expect(hop(1).method).toBe("POST");
    expect(hop(1).body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(hop(1).body as ArrayBuffer)).toBe(
      '{"model":"gpt-4o"}',
    );
  });

  it("still downgrades a Request input's 302 POST to a bodyless GET", async () => {
    serveHops([
      new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1/hop-2" },
      }),
      new Response("ok"),
    ]);

    await secureFetch(
      new Request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"gpt-4o"}',
      }),
    );

    expect(hop(1).method).toBe("GET");
    expect(hop(1).body ?? null).toBeNull();
  });

  // A `Request` input carries its body on the object, and the chain issues every
  // hop against a URL with `body` set explicitly, so the first hop is where the
  // body's bytes have to be named. Reading them only when a redirect needs them
  // meant a POST built from a Request reached the server with no body at all.
  it("hands a Request input's body to hop one unbuffered", async () => {
    // The Request itself is hop one's target, so the plugin streams its body as
    // it always has. Buffering it here would duplicate every streamed upload to
    // serve the redirect case, which mostly never arrives.
    const targets: unknown[] = [];
    const responses = [new Response("ok")];
    serveHops([new Response("ok")]);
    pluginFetchMock.mockImplementation((input: unknown) => {
      targets.push(input);
      const next = responses.shift();
      return Promise.resolve(next ?? new Response("ok"));
    });

    const request = new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });

    await secureFetch(request);

    expect(targets[0]).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });

  it("leaves a Request input readable for the caller after sending it", async () => {
    serveHops([new Response("ok")]);

    const request = new Request("https://api.openai.com/v1/models", {
      method: "POST",
      body: '{"mine":true}',
    });

    await secureFetch(request);

    expect(request.bodyUsed).toBe(false);
  });

  it("sends no body for a Request input that has none", async () => {
    serveHops([new Response("ok")]);

    await secureFetch(new Request("https://api.openai.com/v1/models"));

    expect(hop(0).body ?? null).toBeNull();
  });

  it("preserves every byte value in a private-network response body", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      bodyBase64: btoa(String.fromCharCode(...bytes)),
    });
    const response = await secureFetch("http://10.0.0.5:11434/binary");
    const copy = response.clone();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(bytes);
    expect(pluginFetchMock).not.toHaveBeenCalled();
  });

  it("rejects relative URLs with a contextual error instead of bare Invalid URL", async () => {
    await expect(secureFetch("/v1/models")).rejects.toThrow(
      /secureFetch requires an absolute http\(s\) URL.*\/v1\/models/,
    );
    expect(pluginFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes plaintext requests through the Rust host validator", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeBase64('{"models":[]}'),
    });

    const response = await secureFetch("http://10.0.0.5:11434/api/tags", {
      method: "POST",
      headers: { Authorization: "Bearer local" },
      body: "request body",
    });

    expect(pluginFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("private_http_request", {
      request: {
        requestId: expect.any(String),
        url: "http://10.0.0.5:11434/api/tags",
        method: "POST",
        headers: {
          authorization: "Bearer local",
          "content-type": "text/plain;charset=UTF-8",
        },
        bodyBase64: expect.any(String),
      },
    });
    const privateRequest = invokeMock.mock.calls.find(
      ([command]) => command === "private_http_request",
    )?.[1]?.request;
    if (!privateRequest) throw new Error("Expected a private HTTP request");
    expect(decodeBase64(privateRequest.bodyBase64)).toBe("request body");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [] });
  });

  it("keeps Base64 framing intact across the request chunk boundary", async () => {
    const requestBody = Uint8Array.from(
      { length: 24 * 1024 + 2 },
      (_value, index) => index % 251,
    );
    invokeMock.mockResolvedValue({
      status: 200,
      headers: {},
      bodyBase64: "",
    });

    await secureFetch("http://127.0.0.1:11434/upload", {
      method: "POST",
      body: requestBody,
    });

    const privateRequest = invokeMock.mock.calls.find(
      ([command]) => command === "private_http_request",
    )?.[1]?.request;
    if (!privateRequest) throw new Error("Expected a private HTTP request");
    const decoded = decodeBase64(privateRequest.bodyBase64);
    expect(decoded).toHaveLength(requestBody.length);
    expect(
      Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    ).toEqual(requestBody);
  });

  it("rejects a malformed Base64 response frame", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "text/plain" },
      bodyBase64: "not-base64!",
    });

    await expect(
      secureFetch("http://127.0.0.1:11434/api/tags"),
    ).rejects.toThrow("Private-network response body is not valid base64");
  });

  it("routes saved hosted OpenAI-compatible endpoints through the authorized command", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeBase64('{"data":[]}'),
    });

    const customFetch = createOpenAICompatibleFetch("custom-key-id");
    const response = await customFetch(
      "https://llm.example.com/proxy/openai/v1/models",
      { headers: { Authorization: "Bearer secret" } },
    );

    expect(pluginFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("openai_compatible_http_request", {
      apiKeyId: "custom-key-id",
      request: {
        requestId: expect.any(String),
        url: "https://llm.example.com/proxy/openai/v1/models",
        method: "GET",
        headers: { authorization: "Bearer secret" },
        bodyBase64: null,
      },
    });
    expect(response.status).toBe(200);
  });

  it("preserves a serialised IPC error's own message", async () => {
    invokeMock.mockRejectedValue({ message: "private endpoint denied" });

    await expect(
      secureFetch("http://127.0.0.1:11434/api/tags"),
    ).rejects.toThrow("Tauri IPC error: private endpoint denied");
  });

  it("does not start a native request for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      secureFetch("http://127.0.0.1:11434/api/tags", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cancels the underlying Rust request when its signal aborts", async () => {
    let finishRequest!: (response: PrivateHttpResponseFixture) => void;
    const rustRequest = new Promise<PrivateHttpResponseFixture>((resolve) => {
      finishRequest = resolve;
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "private_http_request") return rustRequest;
      if (command === "cancel_private_http_request")
        return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });

    const controller = new AbortController();
    const pending = secureFetch("http://127.0.0.1:11434/api/tags", {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "private_http_request",
        expect.any(Object),
      );
    });
    const privateCall = invokeMock.mock.calls.find(
      ([command]) => command === "private_http_request",
    );
    const requestId = privateCall?.[1]?.request?.requestId;
    expect(requestId).toEqual(expect.any(String));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("cancel_private_http_request", {
        requestId,
      });
    });

    finishRequest({ status: 204, headers: {}, bodyBase64: "" });
  });
});

type PrivateHttpResponseFixture = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};
