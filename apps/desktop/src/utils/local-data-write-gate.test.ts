import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentWindowMock } = vi.hoisted(() => ({
  getCurrentWindowMock: vi.fn(() => ({ label: "main" })),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

import {
  beginLocalDataClear,
  beginLocalDataWrite,
  hasPendingLocalDataClear,
  isLocalDataClearRequested,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
  withLocalDataWrite,
} from "./local-data-write-gate";

let storageEntries = new Map<string, string>();

const createStorage = (): Storage =>
  ({
    get length() {
      return storageEntries.size;
    },
    key: (index: number) => [...storageEntries.keys()][index] ?? null,
    getItem: (key: string) => storageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageEntries.set(key, value);
    },
    removeItem: (key: string) => {
      storageEntries.delete(key);
    },
    clear: () => storageEntries.clear(),
  }) satisfies Storage;

describe("local data write gate", () => {
  beforeEach(() => {
    getCurrentWindowMock.mockReturnValue({ label: "main" });
    storageEntries = new Map();
    vi.stubGlobal("window", { localStorage: createStorage() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("drains active writes and blocks new writes until every clear finishes", async () => {
    const releaseFirstWrite = beginLocalDataWrite();
    const releaseSecondWrite = beginLocalDataWrite();
    expect(releaseFirstWrite).not.toBeNull();
    expect(releaseSecondWrite).not.toBeNull();

    let releaseFirstClear: (() => void) | undefined;
    let releaseSecondClear: (() => void) | undefined;
    const firstClear = beginLocalDataClear();
    const secondClear = beginLocalDataClear();
    let firstClearReady = false;
    let secondClearReady = false;
    const firstClearObserved = firstClear.then((release) => {
      releaseFirstClear = release;
      firstClearReady = true;
    });
    const secondClearObserved = secondClear.then((release) => {
      releaseSecondClear = release;
      secondClearReady = true;
    });

    try {
      expect(beginLocalDataWrite()).toBeNull();
      expect(firstClearReady).toBe(false);
      expect(secondClearReady).toBe(false);

      releaseFirstWrite?.();
      await Promise.resolve();
      expect(firstClearReady).toBe(false);
      expect(secondClearReady).toBe(false);

      releaseSecondWrite?.();
      await Promise.all([
        firstClear,
        firstClearObserved,
        secondClear,
        secondClearObserved,
      ]);
      expect(firstClearReady).toBe(true);
      expect(secondClearReady).toBe(true);
      expect(beginLocalDataWrite()).toBeNull();
      expect(hasPendingLocalDataClear()).toBe(true);

      releaseFirstClear?.();
      expect(beginLocalDataWrite()).toBeNull();
      storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseSecondClear?.();
      const releaseNextWrite = beginLocalDataWrite();
      expect(releaseNextWrite).not.toBeNull();
      releaseNextWrite?.();
    } finally {
      releaseFirstWrite?.();
      releaseSecondWrite?.();
      storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseFirstClear?.();
      releaseSecondClear?.();
      if (!releaseFirstClear) {
        const release = await firstClear;
        release();
      }
      if (!releaseSecondClear) {
        const release = await secondClear;
        release();
      }
    }
  });

  it("keeps the interruption marker until the clear is completed", async () => {
    expect(isLocalDataClearRequested()).toBe(false);

    const releaseClear = await beginLocalDataClear();
    try {
      expect(isLocalDataClearRequested()).toBe(true);
      expect(hasPendingLocalDataClear()).toBe(true);
      expect(beginLocalDataWrite()).toBeNull();
    } finally {
      storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }

    expect(isLocalDataClearRequested()).toBe(false);
  });

  it("preserves the value of a recovery marker that already exists", async () => {
    storageEntries.set(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "interrupted");

    const releaseClear = await beginLocalDataClear();
    try {
      expect(hasPendingLocalDataClear()).toBe(true);
      expect(storageEntries.get(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY)).toBe(
        "interrupted",
      );
    } finally {
      storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }

    expect(isLocalDataClearRequested()).toBe(false);
  });

  it("keeps writes blocked if the clear marker cannot be checked on release", async () => {
    const releaseClear = await beginLocalDataClear();
    const storage = window.localStorage;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = () => {
      throw new Error("localStorage became unavailable");
    };

    releaseClear();
    expect(isLocalDataClearRequested()).toBe(true);
    expect(beginLocalDataWrite()).toBeNull();

    storage.getItem = originalGetItem;
    const retryRelease = await beginLocalDataClear();
    storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    retryRelease();
    expect(isLocalDataClearRequested()).toBe(false);
  });

  it("fails closed when the current window identity cannot be read", async () => {
    getCurrentWindowMock.mockImplementation(() => {
      throw new Error("window label unavailable");
    });

    expect(beginLocalDataWrite()).toBeNull();
    await expect(withLocalDataWrite(async () => undefined)).rejects.toThrow(
      "Local data writes are only allowed from the main window.",
    );
    await expect(beginLocalDataClear()).rejects.toThrow(
      "Only the main window can clear local data.",
    );
  });

  it("keeps an explicit lease valid until every nested write settles", async () => {
    const releaseOwner = beginLocalDataWrite();
    expect(releaseOwner).not.toBeNull();
    if (!releaseOwner) throw new Error("expected an owner lease");

    let finishChild: (() => void) | undefined;
    const child = withLocalDataWrite(
      (lease) =>
        new Promise<void>((resolve) => {
          expect(lease).toBe(releaseOwner.lease);
          finishChild = resolve;
        }),
      releaseOwner.lease,
    );

    releaseOwner();
    let clearReady = false;
    const clearing = beginLocalDataClear().then((release) => {
      clearReady = true;
      return release;
    });
    await Promise.resolve();
    expect(clearReady).toBe(false);

    finishChild?.();
    await child;
    const releaseClear = await clearing;
    expect(clearReady).toBe(true);
    storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    releaseClear();
  });

  it("rejects a guarded operation instead of starting it during clear", async () => {
    const releaseClear = await beginLocalDataClear();
    let didWrite = false;

    try {
      await expect(
        withLocalDataWrite(async () => {
          didWrite = true;
        }),
      ).rejects.toThrow("Local data is being cleared.");
      expect(didWrite).toBe(false);
    } finally {
      storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }
  });

  it("allows preview repository writes without enabling a local-data clear", async () => {
    vi.stubEnv("MODE", "preview");
    getCurrentWindowMock.mockReturnValue({ label: "preview" });

    const operation = vi.fn(async () => "preview write");
    await expect(withLocalDataWrite(operation)).resolves.toBe("preview write");
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(beginLocalDataClear()).rejects.toThrow(
      "Only the main window can clear local data.",
    );
  });

  it("allows local-data writes and clears only from the main window", async () => {
    getCurrentWindowMock.mockReturnValue({ label: "composer" });

    expect(beginLocalDataWrite()).toBeNull();
    await expect(withLocalDataWrite(async () => undefined)).rejects.toThrow(
      "Local data writes are only allowed from the main window.",
    );
    await expect(beginLocalDataClear()).rejects.toThrow(
      "Only the main window can clear local data.",
    );
  });

  it("restores the write block when a pending clear survives a WebView reload", async () => {
    storageEntries.set(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "1");
    vi.resetModules();

    const reloadedGate = await import("./local-data-write-gate");
    expect(reloadedGate.hasPendingLocalDataClear()).toBe(true);
    expect(reloadedGate.isLocalDataClearRequested()).toBe(true);
    expect(reloadedGate.beginLocalDataWrite()).toBeNull();

    storageEntries.delete(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    const storage = window.localStorage;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = () => {
      throw new Error("localStorage is temporarily unavailable");
    };
    vi.resetModules();
    const unreadableGate = await import("./local-data-write-gate");
    expect(unreadableGate.isLocalDataClearRequested()).toBe(true);
    expect(unreadableGate.beginLocalDataWrite()).toBeNull();

    storage.getItem = originalGetItem;
    vi.resetModules();
    const cleanGate = await import("./local-data-write-gate");
    expect(cleanGate.isLocalDataClearRequested()).toBe(false);
  });
});
