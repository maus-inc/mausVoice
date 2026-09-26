import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { OpenRouterConfig } from "@maus-inc/types";
import { LocalApiKeyRepo } from "./api-key.repo";
import {
  OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH,
  buildOpenAICompatibleTranscriptionUrl,
} from "../utils/openai-compatible.utils";

describe("LocalApiKeyRepo - transcription path persistence and clear contract", () => {
  let repo: LocalApiKeyRepo;

  beforeEach(() => {
    invokeMock.mockReset();
    repo = new LocalApiKeyRepo();
  });

  it("distinguishes an omitted transcriptionPath from an explicit clear", async () => {
    // 1. Initial key created with custom path
    const initialKey = {
      id: "key-123",
      name: "Custom OpenAI-Compat",
      provider: "openai-compatible" as const,
      createdAt: 1000,
      baseUrl: "https://llm.internal.corp/v1",
      transcriptionPath: "/custom/v2/transcribe",
    };

    // 2. Update without specifying transcriptionPath (omitted / undefined)
    invokeMock.mockResolvedValueOnce({
      ...initialKey,
      name: "Renamed OpenAI-Compat",
    });

    await repo.updateApiKey({
      id: "key-123",
      name: "Renamed OpenAI-Compat",
    });

    expect(invokeMock).toHaveBeenLastCalledWith("api_key_update", {
      request: {
        id: "key-123",
        name: "Renamed OpenAI-Compat",
        clearTranscriptionPath: undefined,
        openRouterConfig: undefined,
      },
    });

    // 3. User clears the custom path in UI (passes transcriptionPath: null)
    invokeMock.mockResolvedValueOnce({
      ...initialKey,
      name: "Renamed OpenAI-Compat",
      transcriptionPath: null,
    });

    const clearedKey = await repo.updateApiKey({
      id: "key-123",
      transcriptionPath: null,
    });

    // Verifies that clearTranscriptionPath: true is explicitly passed in the contract
    expect(invokeMock).toHaveBeenLastCalledWith("api_key_update", {
      request: {
        id: "key-123",
        transcriptionPath: null,
        clearTranscriptionPath: true,
        openRouterConfig: undefined,
      },
    });

    // Verifies that the reloaded key has null transcriptionPath
    expect(clearedKey.transcriptionPath).toBeNull();

    // Verifies the provider receives the default path rather than the stale custom path
    const effectiveUrl = buildOpenAICompatibleTranscriptionUrl(
      clearedKey.baseUrl,
      undefined,
      clearedKey.transcriptionPath,
    );

    expect(effectiveUrl).toBe(
      `https://llm.internal.corp/v1${OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH}`,
    );
    expect(effectiveUrl).not.toContain("/custom/v2/transcribe");
  });

  it("persists a newly configured custom transcription path when provided", async () => {
    const updatedKeyData = {
      id: "key-456",
      name: "Local VLLM",
      provider: "openai-compatible" as const,
      createdAt: 2000,
      baseUrl: "http://127.0.0.1:8000",
      transcriptionPath: "/whisper/endpoint",
    };

    invokeMock.mockResolvedValueOnce(updatedKeyData);

    const saved = await repo.updateApiKey({
      id: "key-456",
      transcriptionPath: "/whisper/endpoint",
    });

    expect(invokeMock).toHaveBeenLastCalledWith("api_key_update", {
      request: {
        id: "key-456",
        transcriptionPath: "/whisper/endpoint",
        clearTranscriptionPath: undefined,
        openRouterConfig: undefined,
      },
    });

    expect(saved.transcriptionPath).toBe("/whisper/endpoint");

    const effectiveUrl = buildOpenAICompatibleTranscriptionUrl(
      saved.baseUrl,
      true,
      saved.transcriptionPath,
    );
    expect(effectiveUrl).toBe("http://127.0.0.1:8000/v1/whisper/endpoint");
  });
});

// The Rust `ApiKeyView` field carries `#[serde(rename = "openRouterConfig")]`,
// which overrides the struct's `rename_all = "camelCase"`. Typing the fixture
// against the generated binding means changing that rename breaks the build
// here instead of silently regressing the read below.
type ApiKeyViewWire = {
  id: string;
  name: string;
  provider: string;
  createdAt: number;
  openRouterConfig?: string | null;
};

describe("LocalApiKeyRepo - openRouterConfig wire key casing", () => {
  let repo: LocalApiKeyRepo;

  const storedConfig: OpenRouterConfig = {
    favoriteModels: ["anthropic/claude-sonnet-4"],
    providerRouting: { order: ["anthropic", "together"] },
  };

  beforeEach(() => {
    invokeMock.mockReset();
    repo = new LocalApiKeyRepo();
  });

  it("reads the camel-R openRouterConfig wire key and parses it", async () => {
    const wire: ApiKeyViewWire = {
      id: "key-openrouter",
      name: "OpenRouter",
      provider: "openrouter",
      createdAt: 1000,
      openRouterConfig: JSON.stringify(storedConfig),
    };

    invokeMock.mockResolvedValueOnce([wire]);

    const [key] = await repo.listApiKeys();

    expect(key.openRouterConfig).toEqual(storedConfig);
  });

  it("round-trips openRouterConfig so a read cannot lose what a write stored", async () => {
    const wire: ApiKeyViewWire = {
      id: "key-openrouter",
      name: "OpenRouter",
      provider: "openrouter",
      createdAt: 1000,
      openRouterConfig: JSON.stringify(storedConfig),
    };

    // The update must send the camel-R key the Rust side deserializes.
    invokeMock.mockResolvedValueOnce(wire);
    await repo.updateApiKey({
      id: "key-openrouter",
      openRouterConfig: storedConfig,
    });

    const [, args] = invokeMock.mock.calls.at(-1) as [
      string,
      { request: Record<string, unknown> },
    ];
    expect(args.request).toHaveProperty("openRouterConfig");
    expect(args.request).not.toHaveProperty("openrouterConfig");

    // And the record handed back must survive the same mapping, so a later
    // toggle of the sibling field cannot silently drop this one.
    invokeMock.mockResolvedValueOnce([wire]);
    const [key] = await repo.listApiKeys();
    expect(key.openRouterConfig).toEqual(storedConfig);
  });
});
