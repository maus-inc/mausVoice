import { produce } from "immer";
import { isEqual } from "lodash-es";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { createWithEqualityFn } from "zustand/traditional";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { INITIAL_LOCAL_STATE } from "../state/local.state";
import {
  type LocalDataWriteLease,
  getSynchronousLocalDataWriteLease,
  isMainLocalDataWindow,
  withLocalDataWriteSync,
  withSynchronousLocalDataWriteLease,
} from "../utils/local-data-write-gate";

// Preview state must never read or overwrite a user's desktop preferences.
// Vite exposes VITE_PREVIEW only from the dedicated preview mode.
const IS_BROWSER_PREVIEW = import.meta.env.VITE_PREVIEW === "true";
const CURRENT_STORAGE_KEY = IS_BROWSER_PREVIEW
  ? "mausvoice-browser-preview-local-state"
  : "mausvoice-local-state";
const LEGACY_STORAGE_KEY = "voquill-local-state";

const guardedStateStorage: StateStorage = {
  getItem(name) {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    const lease = getSynchronousLocalDataWriteLease() ?? undefined;
    try {
      withLocalDataWriteSync(() => {
        localStorage.setItem(name, value);
      }, lease);
    } catch (error) {
      console.error(`Unable to persist app state key "${name}":`, error);
    }
  },
  removeItem(name) {
    const lease = getSynchronousLocalDataWriteLease() ?? undefined;
    try {
      withLocalDataWriteSync(() => {
        localStorage.removeItem(name);
      }, lease);
    } catch (error) {
      console.error(`Unable to remove app state key "${name}":`, error);
    }
  },
};

type PersistedAppState = Pick<AppState, "local">;

const appStateStorage = createJSONStorage<PersistedAppState>(
  () => guardedStateStorage,
);

// The rebrand renamed the persisted Zustand key from "voquill-local-state" to
// "mausvoice-local-state", which would otherwise reset users' local settings.
// Copy it once, before hydration, only from the main window.
function migrateLegacyPersistedState(): void {
  try {
    const current = localStorage.getItem(CURRENT_STORAGE_KEY);
    if (current !== null) {
      return;
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null) {
      return;
    }
    withLocalDataWriteSync(() => {
      localStorage.setItem(CURRENT_STORAGE_KEY, legacy);
    });
  } catch {
    // Storage unavailable; the store will use its defaults.
  }
}

if (!IS_BROWSER_PREVIEW && isMainLocalDataWindow()) {
  migrateLegacyPersistedState();
}

export const useAppStore = createWithEqualityFn<AppState>()(
  persist(() => INITIAL_APP_STATE, {
    name: CURRENT_STORAGE_KEY,
    storage: appStateStorage,
    partialize: (state) => ({ local: state.local }),
    merge: (persisted, current) => {
      const stored = (persisted ?? {}) as Partial<AppState>;
      return {
        ...current,
        ...stored,
        // Stored values overlay the defaults so a local field added after a
        // user's snapshot still gets its initial value.
        local: {
          ...current.local,
          ...stored.local,
          // An ephemeral session is scoped to one run of the app. Restoring it
          // would leave persistence suppressed with no session in progress.
          ephemeralSessionActive: INITIAL_LOCAL_STATE.ephemeralSessionActive,
        },
      };
    },
  }),
  isEqual,
);

export const setAppState = useAppStore.setState;

export const getAppState = useAppStore.getState;

export const produceAppState = (
  fn: (draft: AppState) => void,
  lease?: LocalDataWriteLease,
): void => {
  const update = (): void => {
    setAppState((state) => produce(state, fn));
  };

  if (lease) {
    withSynchronousLocalDataWriteLease(lease, update);
    return;
  }
  update();
};
