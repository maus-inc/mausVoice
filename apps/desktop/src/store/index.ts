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
  LEGACY_LOCAL_STATE_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  PREVIEW_LOCAL_STATE_STORAGE_KEY,
} from "../utils/local-storage.utils";
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
  ? PREVIEW_LOCAL_STATE_STORAGE_KEY
  : LOCAL_STATE_STORAGE_KEY;
const LEGACY_STORAGE_KEY = LEGACY_LOCAL_STATE_STORAGE_KEY;

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

/**
 * Drop this window's copy of the local slice when another one wipes storage.
 *
 * The app runs more than one window (a floating composer, for instance) and
 * they all share this key while each keeps its own slice in memory. When one
 * of them wipes local data, the others would write their stale slice — the
 * profile photo in it — straight back out on their next state change, undoing
 * a wipe they were never told about. The browser delivers that news as a
 * `storage` event with a null value for the removed key, and the answer is to
 * forget the copy in memory so the next write persists what is actually left.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    // The event fires for sessionStorage too, and that one is a different
    // store entirely: only the local key's removal is this window's business.
    if (event.storageArea !== localStorage) {
      return;
    }
    if (event.key === CURRENT_STORAGE_KEY && event.newValue === null) {
      setAppState((state) => ({ ...state, local: INITIAL_LOCAL_STATE }));
    }
  });
}
