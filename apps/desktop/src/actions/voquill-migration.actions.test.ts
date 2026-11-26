import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchStatusMock,
  dismissNoticeMock,
  retryMigrationMock,
  refreshCurrentUserMock,
  loadApiKeysMock,
  loadHotkeysMock,
  loadDictionaryMock,
  loadTonesMock,
  loadAppTargetsMock,
} = vi.hoisted(() => ({
  fetchStatusMock: vi.fn(),
  dismissNoticeMock: vi.fn(),
  retryMigrationMock: vi.fn(),
  refreshCurrentUserMock: vi.fn(),
  loadApiKeysMock: vi.fn(),
  loadHotkeysMock: vi.fn(),
  loadDictionaryMock: vi.fn(),
  loadTonesMock: vi.fn(),
  loadAppTargetsMock: vi.fn(),
}));

vi.mock("../repos/voquill-migration.repo", () => ({
  fetchVoquillMigrationStatus: (...args: unknown[]) => fetchStatusMock(...args),
  dismissVoquillMigrationNotice: (...args: unknown[]) =>
    dismissNoticeMock(...args),
  retryVoquillMigration: (...args: unknown[]) => retryMigrationMock(...args),
}));

vi.mock("./user.actions", () => ({
  refreshCurrentUser: (...args: unknown[]) => refreshCurrentUserMock(...args),
}));

vi.mock("./api-key.actions", () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}));

vi.mock("./hotkey.actions", () => ({
  loadHotkeys: (...args: unknown[]) => loadHotkeysMock(...args),
}));

vi.mock("./dictionary.actions", () => ({
  loadDictionary: (...args: unknown[]) => loadDictionaryMock(...args),
}));

vi.mock("./tone.actions", () => ({
  loadTones: (...args: unknown[]) => loadTonesMock(...args),
}));

vi.mock("./app-target.actions", () => ({
  loadAppTargets: (...args: unknown[]) => loadAppTargetsMock(...args),
}));

import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  dismissVoquillMigration,
  loadVoquillMigrationStatus,
  runVoquillMigrationRetry,
} from "./voquill-migration.actions";
import { refreshVoquillMigrationStatusIfActive } from "./voquill-migration-refresh";

const makeReport = (
  overrides: Partial<VoquillMigrationReport> = {},
): VoquillMigrationReport => ({
  schemaVersion: 1,
  status: "completed",
  legacyDetected: true,
  legacySourcePreserved: true,
  canRetry: false,
  detectedAt: "2026-11-24T00:00:00Z",
  completedAt: "2026-11-24T00:00:01Z",
  dismissedAt: null,
  attemptCount: 1,
  databasePhase: "migrated",
  modelsPhase: "not_found",
  audioPhase: "not_found",
  storagePhase: "not_found",
  counts: {
    hasProfile: true,
    hasPreferences: true,
    transcriptions: 12,
    dictionaryTerms: 4,
    tones: 2,
    hotkeys: 3,
    appTargets: 1,
    providerEntries: 1,
    providersNeedingAttention: 1,
    localModelsMigrated: 0,
    audioFilesMigrated: 0,
    storageFilesMigrated: 0,
  },
  removedModesReset: [],
  actionItems: [
    {
      kind: "reenter_api_keys",
      targetSection: "ai-models",
      count: 1,
      providers: ["Groq"],
    },
  ],
  issues: [],
  ...overrides,
});

describe("voquill-migration.actions", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    fetchStatusMock.mockReset();
    dismissNoticeMock.mockReset();
    retryMigrationMock.mockReset();
    refreshCurrentUserMock.mockReset().mockResolvedValue(undefined);
    loadApiKeysMock.mockReset().mockResolvedValue(undefined);
    loadHotkeysMock.mockReset().mockResolvedValue(undefined);
    loadDictionaryMock.mockReset().mockResolvedValue(undefined);
    loadTonesMock.mockReset().mockResolvedValue(undefined);
    loadAppTargetsMock.mockReset().mockResolvedValue(undefined);
  });

  it("loads and stores the migration report", async () => {
    const report = makeReport();
    fetchStatusMock.mockResolvedValue(report);

    const result = await loadVoquillMigrationStatus();
    expect(result).toEqual(report);
    expect(getAppState().voquillMigration.status).toBe("success");
    expect(getAppState().voquillMigration.report).toEqual(report);
  });

  it("marks migration status dismissed", async () => {
    const dismissed = makeReport({ dismissedAt: "2026-11-24T01:00:00Z" });
    dismissNoticeMock.mockResolvedValue(dismissed);

    const result = await dismissVoquillMigration();
    expect(result?.dismissedAt).toBe("2026-11-24T01:00:00Z");
    expect(getAppState().voquillMigration.dismissing).toBe(false);
    expect(getAppState().voquillMigration.report?.dismissedAt).toBe(
      "2026-11-24T01:00:00Z",
    );
  });

  it("reloads hydrated profile data when retry transitions databasePhase to migrated", async () => {
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeReport({
          status: "failed",
          databasePhase: "failed",
          canRetry: true,
        }),
      },
    }));

    const completed = makeReport({
      status: "completed",
      databasePhase: "migrated",
      canRetry: false,
    });
    retryMigrationMock.mockResolvedValue(completed);

    const result = await runVoquillMigrationRetry();
    expect(result.status).toBe("completed");
    expect(getAppState().voquillMigration.retrying).toBe(false);
    expect(refreshCurrentUserMock).toHaveBeenCalledTimes(1);
    expect(loadApiKeysMock).toHaveBeenCalledTimes(1);
    expect(loadHotkeysMock).toHaveBeenCalledTimes(1);
    expect(loadDictionaryMock).toHaveBeenCalledTimes(1);
    expect(loadTonesMock).toHaveBeenCalledTimes(1);
    expect(loadAppTargetsMock).toHaveBeenCalledTimes(1);
  });

  it("does not reload profile data when retry remains failed", async () => {
    const failed = makeReport({
      status: "failed",
      databasePhase: "failed",
      canRetry: true,
    });
    retryMigrationMock.mockResolvedValue(failed);

    const result = await runVoquillMigrationRetry();
    expect(result.status).toBe("failed");
    expect(refreshCurrentUserMock).not.toHaveBeenCalled();
    expect(loadApiKeysMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent retry calls behind a single in-flight backend invocation", async () => {
    let resolveRetry!: (report: VoquillMigrationReport) => void;
    retryMigrationMock.mockImplementationOnce(
      () =>
        new Promise<VoquillMigrationReport>((resolve) => {
          resolveRetry = resolve;
        }),
    );

    const first = runVoquillMigrationRetry();
    const second = runVoquillMigrationRetry();
    expect(retryMigrationMock).toHaveBeenCalledTimes(1);

    const completed = makeReport({
      status: "completed",
      databasePhase: "migrated",
      canRetry: false,
    });
    resolveRetry(completed);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(completed);
    expect(b).toEqual(completed);
    expect(getAppState().voquillMigration.retrying).toBe(false);
  });

  it("discards a stale silent refresh response that resolves after dismissal", async () => {
    const initial = makeReport({ dismissedAt: null });
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: initial,
      },
    }));

    let resolveStaleRefresh!: (report: VoquillMigrationReport) => void;
    fetchStatusMock.mockImplementationOnce(
      () =>
        new Promise<VoquillMigrationReport>((resolve) => {
          resolveStaleRefresh = resolve;
        }),
    );

    const dismissed = makeReport({ dismissedAt: "2026-11-24T03:00:00Z" });
    dismissNoticeMock.mockResolvedValueOnce(dismissed);

    // Start refresh first, then dismiss before the refresh returns.
    const refreshPromise = refreshVoquillMigrationStatusIfActive();
    const dismissResult = await dismissVoquillMigration();
    expect(dismissResult?.dismissedAt).toBe("2026-11-24T03:00:00Z");

    // Stale refresh finally resolves with dismissedAt: null and must be discarded.
    resolveStaleRefresh(makeReport({ dismissedAt: null }));
    await refreshPromise;

    expect(getAppState().voquillMigration.report?.dismissedAt).toBe(
      "2026-11-24T03:00:00Z",
    );
  });

  it("settles loading status when a superseding silent refresh fails", async () => {
    const existing = makeReport({ legacyDetected: true, dismissedAt: null });
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: existing,
      },
    }));

    let resolveSupersededLoad!: (report: VoquillMigrationReport) => void;
    fetchStatusMock
      .mockImplementationOnce(
        () =>
          new Promise<VoquillMigrationReport>((resolve) => {
            resolveSupersededLoad = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("temporary refresh failure"));

    const loadPromise = loadVoquillMigrationStatus(true);
    expect(getAppState().voquillMigration.status).toBe("loading");

    // Superseding silent refresh fails -> status must not remain stuck in "loading".
    await refreshVoquillMigrationStatusIfActive();
    expect(getAppState().voquillMigration.status).toBe("success");

    // Superseded load resolves later -> stale response must still be ignored.
    resolveSupersededLoad(makeReport({ dismissedAt: "2026-11-24T09:00:00Z" }));
    await loadPromise;
    expect(getAppState().voquillMigration.report?.dismissedAt).toBeNull();
  });

  it("forces API key reload when retry promotes the database", async () => {
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeReport({
          status: "failed",
          databasePhase: "failed",
          canRetry: true,
        }),
      },
    }));

    retryMigrationMock.mockResolvedValueOnce(
      makeReport({
        status: "completed",
        databasePhase: "migrated",
        canRetry: false,
      }),
    );

    await runVoquillMigrationRetry();

    expect(loadApiKeysMock).toHaveBeenCalledWith({ force: true });
  });
});
