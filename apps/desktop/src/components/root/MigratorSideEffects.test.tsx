// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import * as localStorageUtils from "../../utils/local-storage.utils";
import { LOCAL_STATE_STORAGE_KEY } from "../../utils/local-storage.utils";
import {
  LEGACY_ASSISTANT_MODE_ENABLED_KEY,
  LEGACY_MODE_FLAGS_MIGRATED_KEY,
  LEGACY_POWER_MODE_ENABLED_KEY,
  migrateLegacyVoquillClientStorage,
} from "../../utils/voquill-client-migration.utils";
import { MigratorSideEffects } from "./MigratorSideEffects";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountMigrator = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MigratorSideEffects />);
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
};

describe("MigratorSideEffects", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    // Clear after setAppState so tests start without a pre-persisted
    // `mausvoice-local-state` envelope unless the test explicitly seeds one.
    window.localStorage.clear();
  });

  it("hydrates a legacy Voquill flag once and never re-enables it after the user turns it off", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");

    const unmountFirst = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(true);
    expect(window.localStorage.getItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY)).toBe(
      "true",
    );
    unmountFirst();

    produceAppState((draft) => {
      draft.local.assistantModeEnabled = false;
    });
    expect(getAppState().local.assistantModeEnabled).toBe(false);

    const unmountSecond = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(false);
    unmountSecond();
  });

  it("does not override an explicitly persisted mausVoice false preference with a retained Voquill flag", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");
    window.localStorage.setItem(
      LOCAL_STATE_STORAGE_KEY,
      JSON.stringify({
        state: { local: { assistantModeEnabled: false } },
        version: 0,
      }),
    );

    const unmount = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(false);
    unmount();
  });

  it("hydrates an absent legacy flag while preserving an explicit false on the sibling flag", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");
    window.localStorage.setItem(LEGACY_POWER_MODE_ENABLED_KEY, "true");
    window.localStorage.setItem(
      LOCAL_STATE_STORAGE_KEY,
      JSON.stringify({
        state: { local: { assistantModeEnabled: false } },
        version: 0,
      }),
    );

    migrateLegacyVoquillClientStorage(window.localStorage);

    const persisted = JSON.parse(
      window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY) ?? "{}",
    ) as { state?: { local?: Record<string, unknown> } };
    expect(persisted.state?.local?.assistantModeEnabled).toBe(false);
    expect(persisted.state?.local?.powerModeEnabled).toBe(true);
  });

  it("ignores malformed legacy boolean flag values", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "yes");
    window.localStorage.setItem(LEGACY_POWER_MODE_ENABLED_KEY, "{}");

    const unmount = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(false);
    expect(getAppState().local.powerModeEnabled).toBe(false);
    unmount();
  });

  it("hydrates both legacy assistant and power flags on mount without pre-hydration", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");
    window.localStorage.setItem(LEGACY_POWER_MODE_ENABLED_KEY, "true");

    const unmount = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(true);
    expect(getAppState().local.powerModeEnabled).toBe(true);
    expect(window.localStorage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY)).toBe(
      "1",
    );
    unmount();
  });

  it("does not write the completion marker when reading legacy storage throws, allowing retry", () => {
    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const flakyStorage = {
      get length() {
        return window.localStorage.length;
      },
      clear: () => window.localStorage.clear(),
      key: (index: number) => window.localStorage.key(index),
      removeItem: (key: string) => window.localStorage.removeItem(key),
      setItem: (key: string, value: string) =>
        window.localStorage.setItem(key, value),
      getItem: (key: string) => {
        if (key === LEGACY_ASSISTANT_MODE_ENABLED_KEY) {
          throw new Error("transient storage failure");
        }
        return window.localStorage.getItem(key);
      },
    } as Storage;
    const storageSpy = vi
      .spyOn(localStorageUtils, "getLocalStorage")
      .mockReturnValueOnce(flakyStorage);

    const unmountFirst = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(false);
    expect(
      window.localStorage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY),
    ).toBeNull();
    unmountFirst();

    storageSpy.mockRestore();
    errorSpy.mockRestore();

    const unmountSecond = mountMigrator();
    expect(getAppState().local.assistantModeEnabled).toBe(true);
    expect(window.localStorage.getItem(LEGACY_MODE_FLAGS_MIGRATED_KEY)).toBe(
      "1",
    );
    unmountSecond();
  });
});
