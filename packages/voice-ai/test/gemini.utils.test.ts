import { vi } from "vitest";
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
