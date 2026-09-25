import { vi } from "vitest";

const UPLOAD_URL = "https://cdn.assemblyai.com/upload/abc123";
type Stage = "upload" | "create" | "status";
type StageHandler = (
  init: RequestInit | undefined,
  attempt: number,
) => Response | Promise<Response> | undefined;

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const requestStage = (url: string, init?: RequestInit): Stage => {
  if (url.endsWith("/v2/upload")) return "upload";
  if (url.endsWith("/v2/transcript") && init?.method === "POST")
    return "create";
  if (url.endsWith("/v2/transcript/t1")) return "status";
  throw new Error(`Unexpected AssemblyAI fixture request: ${url}`);
};

export const mockAssemblyAITranscription = (
  text = "hi",
  overrides: Partial<Record<Stage, StageHandler>> = {},
) => {
  const requests: {
    createBody?: Record<string, unknown>;
    uploadInit?: RequestInit;
    calls: Record<Stage, number>;
  } = { calls: { upload: 0, create: 0, status: 0 } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const stage = requestStage(String(input), init);
    requests.calls[stage] += 1;
    if (stage === "upload") requests.uploadInit = init;
    if (stage === "create") {
      requests.createBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
    }
    const override = await overrides[stage]?.(init, requests.calls[stage]);
    if (override) return override;
    switch (stage) {
      case "upload":
        return jsonResponse({ upload_url: UPLOAD_URL });
      case "create":
        return jsonResponse({ id: "t1", status: "queued" });
      case "status":
        return jsonResponse({ id: "t1", status: "completed", text });
    }
  });
  return requests;
};
