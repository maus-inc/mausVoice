import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import { OpenAICompatibleRepo } from "./ollama.repo";

describe("OpenAICompatibleRepo URL handling", () => {
  it("appends /models directly to the base URL it is given", async () => {
    const calls: string[] = [];
    const customFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
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

  it("does not re-root an already API-versioned base", async () => {
    const calls: string[] = [];
    const customFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
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
