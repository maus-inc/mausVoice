import { describe, expect, it, vi } from "vitest";
import { applyPreviewScenario, invokePreviewCommand } from "./runtime";

vi.mock("./scenarios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scenarios")>();
  return {
    ...actual,
    createPreviewScenario: (
      id: Parameters<typeof actual.createPreviewScenario>[0],
    ) => {
      const snapshot = actual.createPreviewScenario(id);
      const key = snapshot.data.apiKeys[0];
      if (key)
        Object.assign(key, {
          keySuffix: "",
          keyFull: null,
          transcriptionModel: "",
          postProcessingModel: null,
          openRouterConfig: { favoriteModels: ["sample/model"] },
          baseUrl: "https://example.invalid",
          azureRegion: "",
          includeV1Path: false,
          transcriptionPath: "/transcribe",
        });
      return snapshot;
    },
  };
});

describe("preview API key conversion", () => {
  it("preserves optional endpoint fields and falsy values in scenario records", async () => {
    applyPreviewScenario("populated");
    const keys =
      await invokePreviewCommand<Record<string, unknown>[]>("api_key_list");
    expect(keys[0]).toEqual({
      id: "preview-openai-key",
      name: "OpenAI workspace key",
      provider: "openai",
      createdAt: new Date("2026-08-14T09:00:00.000Z").valueOf(),
      keySuffix: "",
      keyFull: null,
      transcriptionModel: "",
      postProcessingModel: null,
      openRouterConfig: JSON.stringify({ favoriteModels: ["sample/model"] }),
      baseUrl: "https://example.invalid",
      azureRegion: "",
      includeV1Path: false,
      transcriptionPath: "/transcribe",
    });
  });
});
