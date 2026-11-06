import type { Hotkey } from "@maus-inc/types";
import { showErrorSnackbar } from "../../actions/app.actions";
import { loadHotkeys } from "../../actions/hotkey.actions";
import { produceAppState, useAppStore } from "../../store";
import { isHotkeyConflict } from "../../utils/hotkey-conflict";
import { createId } from "../../utils/id.utils";

type HotkeyDialog = "dictationLanguageDialogOpen" | "styleHotkeysDialogOpen";

/**
 * Hand out the ids a replacement keeps so a saved row stays the same row.
 * Each snapshot id is used once, in snapshot order, because one action can own
 * several rows ("Add another"). A row with no snapshot id behind it is new and
 * gets a fresh id.
 */
export function createReplacementIdAllocator(
  snapshot: Hotkey[],
): (actionName: string) => string {
  const pending = new Map<string, string[]>();
  for (const hotkey of snapshot) {
    const ids = pending.get(hotkey.actionName);
    if (ids) ids.push(hotkey.id);
    else pending.set(hotkey.actionName, [hotkey.id]);
  }
  return (actionName) => pending.get(actionName)?.shift() ?? createId();
}

function sameHotkeySession(nonce: number, uid: string | null): boolean {
  const state = useAppStore.getState();
  return state.authSessionNonce === nonce && (state.auth?.uid ?? null) === uid;
}

export function isHotkeyDialogCurrent(
  dialog: HotkeyDialog,
  revision: number,
  current: number,
  nonce: number,
  uid: string | null,
): boolean {
  return (
    revision === current &&
    useAppStore.getState().settings[dialog] &&
    sameHotkeySession(nonce, uid)
  );
}

export async function refreshHotkeysAndClose(
  dialog: HotkeyDialog,
  nonce: number,
  uid: string | null,
  stillCurrent: () => boolean,
): Promise<void> {
  if (!sameHotkeySession(nonce, uid)) return;
  await loadHotkeys();
  if (
    !stillCurrent() ||
    useAppStore.getState().settings.hotkeysStatus !== "success"
  )
    return;
  produceAppState((draft) => {
    draft.settings[dialog] = false;
  });
}

function showHotkeySaveError(error: unknown, conflictMessage: string): void {
  showErrorSnackbar(isHotkeyConflict(error) ? conflictMessage : error);
}

/** Serializes same-turn submissions and confines errors to the originating dialog. */
export async function runHotkeyDraftSave(
  saving: { current: boolean },
  setSaving: (value: boolean) => void,
  stillCurrent: () => boolean,
  conflictMessage: () => string,
  operation: () => Promise<void>,
): Promise<void> {
  if (saving.current) return;
  saving.current = true;
  setSaving(true);
  try {
    await operation();
  } catch (error) {
    if (stillCurrent()) showHotkeySaveError(error, conflictMessage());
  } finally {
    saving.current = false;
    setSaving(false);
  }
}
