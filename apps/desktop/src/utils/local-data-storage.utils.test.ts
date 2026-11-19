import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAppLocalStorage,
  removeLocalDataClearPendingMarker,
} from "./local-data-storage.utils";
import { LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY } from "./local-data-write-gate";

describe("clearAppLocalStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes app and Mixpanel queue state without touching Firebase data", () => {
    const entries = new Map<string, string>([
      ["mausvoice-local-state", "local state"],
      ["voquill-local-state", "legacy state"],
      ["tool_always_allow:global:tool", "true"],
      ["mp_test-token_mixpanel", "analytics identity"],
      ["mp_mausvoice-secondary-window", "secondary analytics identity"],
      ["__mpq_test-token_ev", "queued events"],
      ["__mpq_test-token_ev:X", "queue lock"],
      [LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "1"],
      ["firebase:authUser:app:[DEFAULT]", "auth state"],
      ["unrelated-key", "unrelated state"],
    ]);
    const storage = {
      get length() {
        return entries.size;
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
      clear: () => entries.clear(),
    } satisfies Storage;
    vi.stubGlobal("window", { localStorage: storage });

    clearAppLocalStorage();

    expect(entries).toEqual(
      new Map([
        [LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "1"],
        ["firebase:authUser:app:[DEFAULT]", "auth state"],
        ["unrelated-key", "unrelated state"],
      ]),
    );

    removeLocalDataClearPendingMarker();
    expect(entries).toEqual(
      new Map([
        ["firebase:authUser:app:[DEFAULT]", "auth state"],
        ["unrelated-key", "unrelated state"],
      ]),
    );
  });
});
