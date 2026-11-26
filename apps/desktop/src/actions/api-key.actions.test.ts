import type { ApiKey } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listApiKeysMock, clearGenerationRef } = vi.hoisted(() => ({
  listApiKeysMock: vi.fn(),
  clearGenerationRef: { current: 0 },
}));

vi.mock("../repos", () => ({
  getApiKeyRepo: () => ({
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
  }),
}));

vi.mock("../utils/local-data-write-gate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/local-data-write-gate")>();
  return {
    ...actual,
    getLocalDataClearGeneration: () => clearGenerationRef.current,
  };
});

vi.mock("./app.actions", () => ({
  showErrorSnackbar: vi.fn(),
}));

vi.mock("./user.actions", () => ({
  updateUserPreferences: vi.fn(),
}));

vi.mock("./voquill-migration-refresh", () => ({
  refreshVoquillMigrationStatusIfActive: vi.fn(),
}));

import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { loadApiKeys } from "./api-key.actions";

const makeKey = (id: string, name: string): ApiKey => ({
  id,
  name,
  provider: "openai",
  keySuffix: "1234",
  keyFull: "sk-test-1234",
  credentialStatus: "usable",
  credentialIssue: null,
  createdAt: "2026-11-24T00:00:00Z",
});

describe("loadApiKeys", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    listApiKeysMock.mockReset();
    clearGenerationRef.current = 0;
  });

  it("ignores an in-flight forced load that resolves or rejects after a local-data clear starts", async () => {
    let resolveKeys!: (keys: ApiKey[]) => void;
    let rejectKeys!: (error: Error) => void;
    listApiKeysMock
      .mockImplementationOnce(
        () =>
          new Promise<ApiKey[]>((resolve) => {
            resolveKeys = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ApiKey[]>((_, reject) => {
            rejectKeys = reject;
          }),
      );

    const pendingResolve = loadApiKeys({ force: true });
    clearGenerationRef.current += 1;
    resolveKeys([makeKey("key-pre-clear", "Stale Key")]);
    await pendingResolve;
    expect(getAppState().settings.apiKeys).toEqual([]);
    expect(getAppState().settings.apiKeysStatus).toBe("loading");

    const pendingReject = loadApiKeys({ force: true });
    clearGenerationRef.current += 1;
    rejectKeys(new Error("aborted by clear"));
    await pendingReject;
    expect(getAppState().settings.apiKeys).toEqual([]);
    expect(getAppState().settings.apiKeysStatus).toBe("loading");
  });

  it("bypasses and invalidates an in-flight load when forced after DB promotion", async () => {
    let resolveStale!: (keys: ApiKey[]) => void;
    const staleLoad = new Promise<ApiKey[]>((resolve) => {
      resolveStale = resolve;
    });

    const migratedKeys = [makeKey("key-migrated", "Migrated OpenAI")];

    listApiKeysMock
      .mockImplementationOnce(() => staleLoad)
      .mockResolvedValueOnce(migratedKeys);

    // Start a pre-migration load that stays in flight while DB is promoted.
    const preMigrationPromise = loadApiKeys();
    expect(listApiKeysMock).toHaveBeenCalledTimes(1);

    // Force-reloading after migration starts a fresh query.
    await loadApiKeys({ force: true });
    expect(listApiKeysMock).toHaveBeenCalledTimes(2);
    expect(getAppState().settings.apiKeys).toEqual(migratedKeys);
    expect(getAppState().settings.apiKeysStatus).toBe("success");

    // Stale pre-migration promise finally resolves with empty rows -> must not overwrite!
    resolveStale([]);
    await preMigrationPromise;

    expect(getAppState().settings.apiKeys).toEqual(migratedKeys);
    expect(getAppState().settings.apiKeysStatus).toBe("success");
  });

  it("shares an in-flight forced reload with concurrent non-forced callers", async () => {
    let resolveForced!: (keys: ApiKey[]) => void;
    const forcedLoad = new Promise<ApiKey[]>((resolve) => {
      resolveForced = resolve;
    });
    const refreshedKeys = [makeKey("key-fresh", "Refreshed Key")];
    listApiKeysMock.mockImplementationOnce(() => forcedLoad);

    const forcedPromise = loadApiKeys({ force: true });
    expect(getAppState().settings.apiKeysStatus).toBe("loading");

    let nonForcedSettled = false;
    const nonForcedPromise = loadApiKeys().then(() => {
      nonForcedSettled = true;
    });

    await Promise.resolve();
    expect(nonForcedSettled).toBe(false);
    expect(listApiKeysMock).toHaveBeenCalledTimes(1);

    resolveForced(refreshedKeys);
    await Promise.all([forcedPromise, nonForcedPromise]);

    expect(nonForcedSettled).toBe(true);
    expect(getAppState().settings.apiKeys).toEqual(refreshedKeys);
    expect(getAppState().settings.apiKeysStatus).toBe("success");
  });
});
