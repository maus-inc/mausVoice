import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: vi.fn(() =>
    Promise.resolve(new Response("{}", { status: 200 })),
  ),
}));

import { secureFetch } from "../utils/secure-fetch.utils";
import { OllamaRepo, OpenAICompatibleRepo } from "./ollama.repo";

describe("OpenAICompatibleRepo URL handling", () => {
  it("appends /models directly to the base URL it is given", async () => {
    const calls: string[] = [];
    const customFetch = vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    // Callers are responsible for building the /v1 base (see
    // buildOpenAICompatibleUrl); the repo probes `<base>/models`.
    const repo = new OpenAICompatibleRepo(
      "http://127.0.0.1:11434/v1",
      undefined,
      customFetch as typeof fetch,
    );
    await repo.getAvailableModels();

    expect(
      calls.every((url) => url === "http://127.0.0.1:11434/v1/models"),
    ).toBe(true);
  });

  it("passes authorization and cancellation to availability probes", async () => {
    const signal = new AbortController().signal;
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const repo = new OpenAICompatibleRepo(
      "https://proxy.example/v1",
      "key",
      fetch,
    );
    await expect(repo.checkAvailability(signal)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://proxy.example/v1/models", {
      headers: { Authorization: "Bearer key" },
      signal,
    });
    fetch.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(repo.checkAvailability(signal)).resolves.toBe(false);
  });

  it("does not re-root an already API-versioned base", async () => {
    const calls: string[] = [];
    const customFetch = vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    const repo = new OpenAICompatibleRepo(
      "https://proxy.example.com/openai/v1beta",
      undefined,
      customFetch as typeof fetch,
    );
    await repo.getAvailableModels();

    expect(calls).toEqual(["https://proxy.example.com/openai/v1beta/models"]);
  });
});

describe("OllamaRepo HTTP contract", () => {
  it("probes the supplied endpoint with its authorization and signal", async () => {
    const signal = new AbortController().signal;
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("ok", { status: 200 }),
    );
    const repo = new OllamaRepo("http://127.0.0.1:11434", "key");
    await expect(repo.checkAvailability(signal)).resolves.toBe(true);
    expect(secureFetch).toHaveBeenLastCalledWith("http://127.0.0.1:11434", {
      headers: { Authorization: "Bearer key" },
      signal,
    });
  });

  it("reports an unavailable server for HTTP errors and failed probes", async () => {
    const repo = new OllamaRepo("http://127.0.0.1:11434");
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("no", { status: 503 }),
    );
    vi.mocked(secureFetch).mockRejectedValueOnce(new Error("offline"));
    await expect(repo.checkAvailability()).resolves.toBe(false);
    await expect(repo.checkAvailability()).resolves.toBe(false);
  });

  it("loads, trims and filters model names while forwarding the abort signal", async () => {
    const signal = new AbortController().signal;
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: " model-a " },
            { name: "" },
            {},
            { name: "model-b" },
          ],
        }),
        { status: 200 },
      ),
    );
    const repo = new OllamaRepo("http://127.0.0.1:11434/ignored", "key");
    await expect(repo.getAvailableModels(signal)).resolves.toEqual([
      "model-a",
      "model-b",
    ]);
    expect(secureFetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:11434/api/tags",
      {
        headers: { Authorization: "Bearer key" },
        signal,
      },
    );
  });

  it("returns an empty list when the server omits models and propagates HTTP failures", async () => {
    const repo = new OllamaRepo("http://127.0.0.1:11434");
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("{}", { status: 200 }),
    );
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("denied", { status: 403 }),
    );
    await expect(repo.getAvailableModels()).resolves.toEqual([]);
    await expect(repo.getAvailableModels()).rejects.toThrow("status 403");
  });
});

it("rejects a malformed Ollama endpoint without exposing URL credentials", async () => {
  const secret = "private-endpoint-value";
  const error = await new OllamaRepo(`https://user:${secret}@[invalid`)
    .getAvailableModels()
    .then(
      () => null,
      (failure: unknown) => failure,
    );
  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
});

describe.each([
  ["Ollama", () => new OllamaRepo("https://endpoint.example", "key")],
  [
    "OpenAI-compatible",
    () => new OpenAICompatibleRepo("https://endpoint.example/v1", "key"),
  ],
])("%s model picker privacy and cancellation", (_name, makeRepo) => {
  beforeEach(() => {
    vi.mocked(secureFetch).mockReset();
  });

  it("does not expose transport details", async () => {
    vi.mocked(secureFetch).mockRejectedValue(new Error("transport-private"));
    const error = await makeRepo()
      .getAvailableModels()
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("transport-private");
  });

  it("does not expose a throwing transport error accessor", async () => {
    const failure = new Error("unused");
    Object.defineProperty(failure, "name", {
      get() {
        throw new Error("private-accessor-fragment");
      },
    });
    vi.mocked(secureFetch).mockRejectedValue(failure);
    const error = await makeRepo()
      .getAvailableModels()
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("private-accessor-fragment");
  });

  it("discards an unsuccessful discovery response without waiting", async () => {
    const response = new Response("private", { status: 503 });
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockReturnValue(new Promise(() => {}));
    vi.mocked(secureFetch).mockResolvedValue(response);
    await expect(makeRepo().getAvailableModels()).rejects.toThrow("503");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([200, 503])(
    "discards an unused availability response with status %i",
    async (status) => {
      const response = new Response("private", { status });
      const cancel = vi
        .spyOn(response.body!, "cancel")
        .mockReturnValue(new Promise(() => {}));
      vi.mocked(secureFetch).mockResolvedValue(response);
      await expect(makeRepo().checkAvailability()).resolves.toBe(
        status === 200,
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops waiting for an uncooperative availability request", async () => {
    const controller = new AbortController();
    vi.mocked(secureFetch).mockImplementation(() => new Promise(() => {}));
    const outcome = makeRepo().checkAvailability(controller.signal);
    await vi.waitFor(() => expect(secureFetch).toHaveBeenCalledOnce());
    controller.abort(null);
    await expect(
      Promise.race([
        outcome,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("stalled"), 100),
        ),
      ]),
    ).resolves.toBe(false);
  });

  it("stops waiting for a stalled transport and discards its late response", async () => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    vi.mocked(secureFetch).mockImplementation(
      () =>
        new Promise<Response>((finish) => {
          resolve = finish;
        }),
    );
    const pending = makeRepo().getAvailableModels(controller.signal);
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(secureFetch).toHaveBeenCalledOnce());
    controller.abort(null);
    const result = await Promise.race([
      outcome,
      new Promise<string>((finish) => setTimeout(() => finish("stalled"), 100)),
    ]);
    expect(result).toBe(null);
    const late = new Response("private");
    const cancel = vi.spyOn(late.body!, "cancel");
    resolve(late);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("stops waiting for an uncooperative JSON body on cancellation", async () => {
    const controller = new AbortController();
    const response = new Response("private");
    const reading = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise(() => {}));
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.mocked(secureFetch).mockResolvedValue(response);
    const pending = makeRepo().getAvailableModels(controller.signal);
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    controller.abort(null);
    const result = await Promise.race([
      outcome,
      new Promise<string>((finish) => setTimeout(() => finish("stalled"), 100)),
    ]);
    expect(result).toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not expose malformed response fragments", async () => {
    vi.mocked(secureFetch).mockResolvedValue(new Response("s3cr3t"));
    const error = await makeRepo()
      .getAvailableModels()
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("s3cr3t");
  });

  it("keeps independent abort errors recognizable without revealing their details", async () => {
    vi.mocked(secureFetch).mockRejectedValue(
      new DOMException("private-transport-fragment", "AbortError"),
    );
    const error = await makeRepo()
      .getAvailableModels()
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain("private-transport-fragment");
  });

  it("does not dispatch an already cancelled request", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    await expect(makeRepo().getAvailableModels(controller.signal)).rejects.toBe(
      reason,
    );
    expect(secureFetch).not.toHaveBeenCalled();
  });

  it("preserves the cancellation reason if the response parser fails", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during parsing");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("private-response-fragment");
    });
    vi.mocked(secureFetch).mockResolvedValue(response);
    await expect(makeRepo().getAvailableModels(controller.signal)).rejects.toBe(
      reason,
    );
  });

  it("honors cancellation if a body read succeeds after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during parsing");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      return {
        data: [{ id: "private-model" }],
        models: [{ name: "private-model" }],
      };
    });
    vi.mocked(secureFetch).mockResolvedValue(response);
    await expect(makeRepo().getAvailableModels(controller.signal)).rejects.toBe(
      reason,
    );
  });

  it("cancels a response arriving after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during transport");
    const response = new Response("private response");
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.mocked(secureFetch).mockImplementation(async () => {
      controller.abort(reason);
      return response;
    });
    await expect(makeRepo().getAvailableModels(controller.signal)).rejects.toBe(
      reason,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
