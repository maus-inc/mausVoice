import { produce } from "immer";
import { isEqual } from "lodash-es";
import { persist } from "zustand/middleware";
import { createWithEqualityFn } from "zustand/traditional";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { INITIAL_LOCAL_STATE } from "../state/local.state";

const CURRENT_STORAGE_KEY = "mausvoice-local-state";
const LEGACY_STORAGE_KEY = "voquill-local-state";

// The rebrand renamed the persisted Zustand key from "voquill-local-state" to
// "mausvoice-local-state", which would normally reset every persisted local
// setting for existing users. Before the store rehydrates, migrate the legacy
// value into the current key once, idempotently: only when the current key is
// absent. Both stores persist the same shape ({ local: state.local }), so the
// raw value can be copied as-is.
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
    localStorage.setItem(CURRENT_STORAGE_KEY, legacy);
  } catch {
    // Storage unavailable (e.g. restricted environment); fall through to defaults.
  }
}

migrateLegacyPersistedState();

export const useAppStore = createWithEqualityFn<AppState>()(
  persist(() => INITIAL_APP_STATE, {
    name: CURRENT_STORAGE_KEY,
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

export const produceAppState = (fn: (draft: AppState) => void) => {
  setAppState((state) => produce(state, fn));
};
