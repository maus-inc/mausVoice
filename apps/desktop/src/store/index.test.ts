import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "mausvoice-local-state";

// The zustand persist middleware reads `window.localStorage`, so it stays
// inert in the node test environment without a `window`. The app runs in a
// webview where `window` always exists.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage },
});

const seedPersistedLocal = (local: Record<string, unknown>) => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { local }, version: 0 }),
  );
};

const loadRehydratedLocal = async () => {
  const { getAppState } = await import("./index");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return getAppState().local;
};

describe("app store rehydration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("drops an ephemeral session left over from a previous run", async () => {
    seedPersistedLocal({ ephemeralSessionActive: true });

    const local = await loadRehydratedLocal();

    expect(local.ephemeralSessionActive).toBe(false);
  });

  it("keeps persisted local fields that are not session scoped", async () => {
    seedPersistedLocal({
      ephemeralSessionActive: true,
      powerModeEnabled: true,
      hasHiddenTrialExtensionCard: true,
    });

    const local = await loadRehydratedLocal();

    expect(local.powerModeEnabled).toBe(true);
    expect(local.hasHiddenTrialExtensionCard).toBe(true);
  });

  it("falls back to the initial value for a local field absent from storage", async () => {
    seedPersistedLocal({ powerModeEnabled: true });

    const local = await loadRehydratedLocal();

    expect(local.disablePillRewards).toBe(false);
    expect(local.assistantModeEnabled).toBe(false);
  });

  it("starts from the initial state when nothing is persisted", async () => {
    const local = await loadRehydratedLocal();

    expect(local.ephemeralSessionActive).toBe(false);
    expect(local.powerModeEnabled).toBe(false);
  });
});
