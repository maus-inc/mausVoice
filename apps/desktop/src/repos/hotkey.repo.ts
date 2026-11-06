import { Hotkey } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { BaseRepo } from "./base.repo";

export abstract class BaseHotkeyRepo extends BaseRepo {
  abstract listHotkeys(): Promise<Hotkey[]>;
  abstract saveHotkey(hotkey: Hotkey): Promise<Hotkey>;
  abstract deleteHotkey(id: string): Promise<void>;
  abstract replaceDictationLanguageHotkeys(
    primary: Hotkey,
    additional: Hotkey[],
    expected: Hotkey[],
  ): Promise<void>;
  abstract replaceStyleHotkeys(
    prefix: string,
    hotkeys: Hotkey[],
    expected: Hotkey[],
  ): Promise<Hotkey[]>;
}

// Repo instances are created per call, but writes must be ordered across them:
// a growing key chord can issue several saves before any IPC call settles.
let hotkeyWrites: Promise<void> = Promise.resolve();
const queueHotkeyWrite = <T>(write: () => Promise<T>): Promise<T> => {
  const result = hotkeyWrites.then(write);
  hotkeyWrites = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const snapshotHotkeys = (hotkeys: Hotkey[]) =>
  hotkeys.map((hotkey) => ({ ...hotkey, keys: [...hotkey.keys] }));

export class LocalHotkeyRepo extends BaseHotkeyRepo {
  listHotkeys(): Promise<Hotkey[]> {
    // A read requested after an optimistic save must not overtake its queued IPC.
    return hotkeyWrites.then(() => invoke<Hotkey[]>("hotkey_list"));
  }

  saveHotkey(hotkey: Hotkey): Promise<Hotkey> {
    const snapshot = { ...hotkey, keys: [...hotkey.keys] };
    return queueHotkeyWrite(() =>
      invoke<Hotkey>("hotkey_save", { hotkey: snapshot }),
    );
  }

  deleteHotkey(id: string): Promise<void> {
    return queueHotkeyWrite(() => invoke<void>("hotkey_delete", { id }));
  }

  replaceDictationLanguageHotkeys(
    primary: Hotkey,
    additional: Hotkey[],
    expected: Hotkey[],
  ): Promise<void> {
    const primarySnapshot = { ...primary, keys: [...primary.keys] };
    const additionalSnapshot = snapshotHotkeys(additional);
    const expectedSnapshot = snapshotHotkeys(expected);
    return queueHotkeyWrite(() =>
      invoke<void>("hotkey_replace_dictation_language_hotkeys", {
        primary: primarySnapshot,
        additional: additionalSnapshot,
        expected: expectedSnapshot,
      }),
    );
  }

  replaceStyleHotkeys(
    prefix: string,
    hotkeys: Hotkey[],
    expected: Hotkey[],
  ): Promise<Hotkey[]> {
    const snapshot = snapshotHotkeys(hotkeys);
    const expectedSnapshot = snapshotHotkeys(expected);
    return queueHotkeyWrite(() =>
      invoke<Hotkey[]>("hotkey_replace_style_hotkeys", {
        prefix,
        hotkeys: snapshot,
        expected: expectedSnapshot,
      }),
    );
  }
}
