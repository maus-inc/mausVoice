import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiGenerateTests } from "../src/test-helpers/shared-gemini-generate.helper";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock:
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(),
}));

const jsonResponse = (text: string) =>
  ({
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  }) as unknown as Response;

createGeminiGenerateTests({
  describeName: "geminiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/gemini.utils");
    return mod;
  },
  functionName: "geminiGenerateTextResponse",
  fetchMock,
  respond: () => jsonResponse("ok"),
  extraParams: { customFetch: fetchMock },
});

describe("geminiGenerateTextResponse request shape", () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  it("prepends the system prompt to the user content", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse("ok")));

    const { geminiGenerateTextResponse } = await import("../src/gemini.utils");

    await geminiGenerateTextResponse({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      prompt: "summarize this",
      system: "Be concise.",
      customFetch: fetchMock,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe(
      "Be concise.\n\nsummarize this",
    );
  });

  it("sends the converted JSON schema with responseMimeType when jsonResponse is set", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse("ok")));

    const { geminiGenerateTextResponse } = await import("../src/gemini.utils");

    await geminiGenerateTextResponse({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      prompt: "hi",
      jsonResponse: {
        name: "schema",
        description: "x",
        schema: {
          type: "object" as const,
          properties: { result: { type: "string" as const } },
          required: ["result"],
        },
      },
      customFetch: fetchMock,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      generationConfig?: {
        responseMimeType?: string;
        responseSchema?: Record<string, unknown>;
      };
    };
    expect(body.generationConfig?.responseMimeType).toBe("application/json");
    expect(body.generationConfig?.responseSchema).toMatchObject({
      type: "OBJECT",
      properties: { result: { type: "STRING" } },
    });
  });
});

describe("geminiTestIntegration", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it("reports the endpoint reachable and keeps the key out of the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(""));

    const { geminiTestIntegration } = await import("../src/gemini.utils");

    await expect(
      geminiTestIntegration({ apiKey: " gemini-key ", customFetch: fetchMock }),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    );
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "gemini-key",
    );
  });

  it("throws with the provider status on a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid key",
    } as unknown as Response);

    const { geminiTestIntegration } = await import("../src/gemini.utils");

    await expect(
      geminiTestIntegration({ apiKey: "bad", customFetch: fetchMock }),
    ).rejects.toThrow("Gemini responded 401");
  });
});
