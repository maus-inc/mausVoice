import type { ApiKey } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listApiKeysMock } = vi.hoisted(() => ({
  listApiKeysMock: vi.fn(),
}));

vi.mock("../repos", () => ({
  getApiKeyRepo: () => ({
    listApiKeys: (...args: unknown[]) => listApiKeysMock(...args),
  }),
}));

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
});
