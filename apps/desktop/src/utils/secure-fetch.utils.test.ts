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

describe("secureFetch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    pluginFetchMock.mockReset();
  });

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
    const decoded = decodeBase64(privateRequest.bodyBase64);
    expect(decoded.length).toBe(requestBody.length);
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
