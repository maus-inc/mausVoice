import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, pluginFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pluginFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: pluginFetchMock }));

import { createOpenAICompatibleFetch, secureFetch } from "./secure-fetch.utils";

describe("secureFetch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    pluginFetchMock.mockReset();
  });

  it("keeps curated HTTPS requests in plugin-http", async () => {
    const expected = new Response("ok");
    pluginFetchMock.mockResolvedValue(expected);

    await expect(secureFetch("https://api.openai.com/v1/models")).resolves.toBe(
      expected,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes plaintext requests through the Rust host validator", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Array.from(new TextEncoder().encode('{"models":[]}')),
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
        body: Array.from(new TextEncoder().encode("request body")),
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [] });
  });

  it("routes saved hosted OpenAI-compatible endpoints through the authorized command", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Array.from(new TextEncoder().encode('{"data":[]}')),
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
        body: null,
      },
    });
    expect(response.status).toBe(200);
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

    finishRequest({ status: 204, headers: {}, body: [] });
  });
});

type PrivateHttpResponseFixture = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};
