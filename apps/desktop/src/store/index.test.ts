import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "mausvoice-local-state";

// The zustand persist middleware reads `window.localStorage`, so it stays
// inert in the node test environment without a `window`. The app runs in a
// webview where `window` always exists.
/** Listeners the store registers, so a test can deliver the event itself. */
const storageListeners: Array<(event: StorageEvent) => void> = [];

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage,
    // The store listens for another window's wipe; capture the registration
    // so a test can hand it the event jsdom would deliver.
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "storage") {
        storageListeners.push(listener as (event: StorageEvent) => void);
      }
    },
  },
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
    storageListeners.length = 0;
    vi.resetModules();
  });

  const deliverStorageEvent = (event: {
    key: string;
    newValue: string | null;
  }) => {
    for (const listener of storageListeners) {
      listener(event as StorageEvent);
    }
  };

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
      onboardingNameDraft: "Mary Jane Watson",
      onboardingNameDraftUserId: "user-id",
      onboardingSessionUserId: "user-id",
    });

    const local = await loadRehydratedLocal();

    expect(local.powerModeEnabled).toBe(true);
    expect(local.hasHiddenTrialExtensionCard).toBe(true);
    expect(local.onboardingNameDraft).toBe("Mary Jane Watson");
    expect(local.onboardingNameDraftUserId).toBe("user-id");
    expect(local.onboardingSessionUserId).toBe("user-id");
  });

  it("falls back to the initial value for a local field absent from storage", async () => {
    seedPersistedLocal({ powerModeEnabled: true });

    const local = await loadRehydratedLocal();

    expect(local.disablePillRewards).toBe(false);
    expect(local.assistantModeEnabled).toBe(false);
  });

  it("drops the local slice when another window wipes stored data", async () => {
    const { getAppState, setAppState } = await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 0));
    setAppState((state) => ({
      ...state,
      local: {
        ...state.local,
        profileImageByUserId: { "user-1": "data:image/png;base64,AAAA" },
      },
    }));

    // A wipe in another window removes the key; the browser tells the other
    // windows by handing them the event with a null value. Without this the
    // window would write its stale slice — photo and all — straight back.
    deliverStorageEvent({ key: STORAGE_KEY, newValue: null });

    expect(getAppState().local.profileImageByUserId).toEqual({});
  });

  it("keeps the slice when a different key changes", async () => {
    const { getAppState, setAppState } = await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 0));
    setAppState((state) => ({
      ...state,
      local: {
        ...state.local,
        profileImageByUserId: { "user-1": "data:image/png;base64,AAAA" },
      },
    }));

    // Another window writing something else is not a wipe of this window's
    // data, and the photo it did not touch stays.
    deliverStorageEvent({ key: "mausvoice:onboarded-at", newValue: "1" });

    expect(getAppState().local.profileImageByUserId).toEqual({
      "user-1": "data:image/png;base64,AAAA",
    });
  });

  it("starts from the initial state when nothing is persisted", async () => {
    const local = await loadRehydratedLocal();

    expect(local.ephemeralSessionActive).toBe(false);
    expect(local.powerModeEnabled).toBe(false);
  });
});
