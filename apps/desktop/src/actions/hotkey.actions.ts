import type { Hotkey } from "@maus-inc/types";
import { getHotkeyRepo } from "../repos";
import type { AppState } from "../state/app.state";
import { getAppState, produceAppState } from "../store";
import { registerHotkeys } from "../utils/app.utils";
import { createId } from "../utils/id.utils";
import { syncHotkeyCombosToNative } from "../utils/keyboard.utils";
import { showErrorSnackbar } from "./app.actions";

type HotkeySnapshot = Pick<AppState, "hotkeyById" | "settings">;

let latestHotkeyLoad = 0;
type HotkeySession = { nonce: number; uid: string | null };
type ActiveHotkeyLoad = {
  session: HotkeySession;
  promise: Promise<void>;
  superseded: Promise<void>;
  supersede: () => void;
};
let activeHotkeyLoad: ActiveHotkeyLoad | null = null;
let loadedHotkeySession: HotkeySession | null = null;

function hotkeySession(state: AppState): HotkeySession {
  return { nonce: state.authSessionNonce, uid: state.auth?.uid ?? null };
}

function sameAuthSession(
  before: HotkeySession | null,
  current: AppState,
): boolean {
  return (
    before !== null &&
    before.nonce === current.authSessionNonce &&
    before.uid === (current.auth?.uid ?? null)
  );
}

function mergeLoadedHotkeys(
  loaded: Hotkey[],
  before: HotkeySnapshot,
  current: HotkeySnapshot,
): Hotkey[] {
  const merged = new Map(loaded.map((hotkey) => [hotkey.id, hotkey]));
  const previousIds = new Set(before.settings.hotkeyIds);
  const currentIds = new Set(current.settings.hotkeyIds);
  const ids = new Set([
    ...Object.keys(before.hotkeyById),
    ...Object.keys(current.hotkeyById),
    ...previousIds,
    ...currentIds,
  ]);
  for (const id of ids) {
    if (
      before.hotkeyById[id] === current.hotkeyById[id] &&
      previousIds.has(id) === currentIds.has(id)
    )
      continue;
    const value = current.hotkeyById[id];
    if (value && currentIds.has(id)) merged.set(id, value);
    else merged.delete(id);
  }
  return [...merged.values()];
}

async function performHotkeyLoad(load: number): Promise<void> {
  const before = getAppState();
  const session = hotkeySession(before);
  produceAppState((draft) => {
    draft.settings.hotkeysStatus = "loading";
  });

  try {
    const loaded = await getHotkeyRepo().listHotkeys();
    if (load !== latestHotkeyLoad || !sameAuthSession(session, getAppState()))
      return;
    const hotkeys = mergeLoadedHotkeys(loaded, before, getAppState());
    produceAppState((draft) => {
      draft.hotkeyById = {};
      registerHotkeys(draft, hotkeys);
      draft.settings.hotkeyIds = hotkeys.map((hotkey) => hotkey.id);
      draft.settings.hotkeysStatus = "success";
    });
    await syncHotkeyCombosToNative();
    if (load === latestHotkeyLoad && sameAuthSession(session, getAppState())) {
      loadedHotkeySession = session;
    }
  } catch (error) {
    if (load !== latestHotkeyLoad || !sameAuthSession(session, getAppState()))
      return;
    console.error("Failed to load hotkeys", error);
    produceAppState((draft) => {
      draft.settings.hotkeysStatus = "error";
    });
    showErrorSnackbar("Failed to load hotkeys. Please try again.");
  }
}

export const loadHotkeys = (): Promise<void> => {
  const revision = ++latestHotkeyLoad;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let supersede!: () => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const superseded = new Promise<void>((done) => {
    supersede = done;
  });
  const previous = activeHotkeyLoad;
  const load = {
    session: hotkeySession(getAppState()),
    promise,
    superseded,
    supersede,
  };
  // Publish before notifying store subscribers, which can start another edit.
  activeHotkeyLoad = load;
  previous?.supersede();
  const clear = () => {
    if (activeHotkeyLoad === load) activeHotkeyLoad = null;
  };
  void promise.then(clear, clear);
  void performHotkeyLoad(revision).then(resolve, reject);
  return promise;
};

export async function ensureHotkeysLoaded(): Promise<boolean> {
  const state = getAppState();
  const activeIsCurrent =
    activeHotkeyLoad && sameAuthSession(activeHotkeyLoad.session, state);
  const loadedIsCurrent =
    state.settings.hotkeysStatus === "success" &&
    sameAuthSession(loadedHotkeySession, state);
  if (activeHotkeyLoad ? !activeIsCurrent : !loadedIsCurrent) {
    void loadHotkeys();
  }
  let pending = activeHotkeyLoad;
  while (pending) {
    await Promise.race([pending.promise, pending.superseded]);
    if (!activeHotkeyLoad || activeHotkeyLoad === pending) break;
    pending = activeHotkeyLoad;
  }
  const current = getAppState();
  return (
    current.settings.hotkeysStatus === "success" &&
    sameAuthSession(loadedHotkeySession, current)
  );
}

/** Update the first binding without creating a duplicate before initial load. */
export const savePrimaryHotkey = async (
  actionName: string,
  keys: string[],
): Promise<void> => {
  const snapshot = [...keys];
  const session = hotkeySession(getAppState());
  try {
    if (!(await ensureHotkeysLoaded())) return;
  } catch (error) {
    console.error("Failed to load hotkeys", error);
    showErrorSnackbar("Failed to load hotkeys. Please try again.");
    return;
  }
  const state = getAppState();
  if (!sameAuthSession(session, state)) return;
  const primary = state.settings.hotkeyIds
    .map((id) => state.hotkeyById[id])
    .find((hotkey) => hotkey?.actionName === actionName);
  await saveHotkey({
    id: primary?.id ?? createId(),
    actionName,
    keys: snapshot,
  });
};

/** Save an optimistic shortcut update, then synchronize the native listener. */
export const saveHotkey = async (hotkey: Hotkey): Promise<void> => {
  try {
    produceAppState((draft) => {
      registerHotkeys(draft, [hotkey]);
      if (!draft.settings.hotkeyIds.includes(hotkey.id)) {
        draft.settings.hotkeyIds.push(hotkey.id);
      }
    });
    await getHotkeyRepo().saveHotkey(hotkey);
    await syncHotkeyCombosToNative();
  } catch (error) {
    console.error("Failed to save hotkey", error);
    showErrorSnackbar("Failed to save hotkey. Please try again.");
  }
};
