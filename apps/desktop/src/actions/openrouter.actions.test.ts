import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    settings: {
      aiPostProcessing: { selectedApiKeyId: "key-id" },
      openRouterModelsStatus: "idle",
      openRouterProvidersStatus: "idle",
    },
    apiKeyById: {
      "key-id": { provider: "openrouter", keyFull: "private-key" },
    },
  },
  fetchModels: vi.fn(),
  fetchProviders: vi.fn(),
}));
vi.mock("../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (update: (state: typeof mocks.state) => void) =>
    update(mocks.state),
}));
vi.mock("../repos/openrouter.repo", () => ({
  getOpenRouterRepo: () => ({ fetchModels: mocks.fetchModels }),
}));
vi.mock("@maus-inc/voice-ai", () => ({
  openrouterFetchProviders: mocks.fetchProviders,
}));
vi.mock("./api-key.actions", () => ({ updateApiKey: vi.fn() }));

import {
  loadOpenRouterModels,
  loadOpenRouterProviders,
} from "./openrouter.actions";

describe("OpenRouter discovery error logging", () => {
  beforeEach(() => {
    mocks.state.settings.openRouterModelsStatus = "idle";
    mocks.state.settings.openRouterProvidersStatus = "idle";
    mocks.fetchModels.mockReset();
    mocks.fetchProviders.mockReset();
  });

  it.each(["models", "providers"] as const)(
    "does not log untrusted %s failures",
    async (kind) => {
      const privateValue = "sensitive-transport-payload";
      const failure = Object.assign(new Error(`failed: ${privateValue}`), {
        details: privateValue,
      });
      mocks.fetchModels.mockRejectedValue(failure);
      mocks.fetchProviders.mockRejectedValue(failure);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        if (kind === "models") await loadOpenRouterModels();
        else await loadOpenRouterProviders();
        expect(
          mocks.state.settings[
            kind === "models"
              ? "openRouterModelsStatus"
              : "openRouterProvidersStatus"
          ],
        ).toBe("error");
        expect(JSON.stringify(log.mock.calls)).not.toContain(privateValue);
      } finally {
        log.mockRestore();
      }
    },
  );
});
