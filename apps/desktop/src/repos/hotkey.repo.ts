import { Hotkey } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export abstract class BaseHotkeyRepo extends BaseRepo {
  abstract listHotkeys(): Promise<Hotkey[]>;
  abstract saveHotkey(
    hotkey: Hotkey,
    lease?: LocalDataWriteLease,
  ): Promise<Hotkey>;
  abstract deleteHotkey(id: string, lease?: LocalDataWriteLease): Promise<void>;
  abstract replaceStyleHotkeys(
    prefix: string,
    hotkeys: Hotkey[],
    lease?: LocalDataWriteLease,
    expected?: Hotkey[],
  ): Promise<Hotkey[]>;
  abstract replaceDictationLanguageHotkeys(
    primary: Hotkey,
    additional: Hotkey[],
    expected: Hotkey[],
    lease?: LocalDataWriteLease,
  ): Promise<void>;
}

export class LocalHotkeyRepo extends BaseHotkeyRepo {
  listHotkeys(): Promise<Hotkey[]> {
    return invoke<Hotkey[]>("hotkey_list");
  }

  saveHotkey(hotkey: Hotkey, lease?: LocalDataWriteLease): Promise<Hotkey> {
    return withLocalDataWrite(
      () => invoke<Hotkey>("hotkey_save", { hotkey }),
      lease,
    );
  }

  deleteHotkey(id: string, lease?: LocalDataWriteLease): Promise<void> {
    return withLocalDataWrite(
      () => invoke<void>("hotkey_delete", { id }),
      lease,
    );
  }

  replaceStyleHotkeys(
    prefix: string,
    hotkeys: Hotkey[],
    lease?: LocalDataWriteLease,
    expected?: Hotkey[],
  ): Promise<Hotkey[]> {
    return withLocalDataWrite(
      () =>
        invoke<Hotkey[]>("hotkey_replace_style_hotkeys", {
          prefix,
          hotkeys,
          expected,
        }),
      lease,
    );
  }

  replaceDictationLanguageHotkeys(
    primary: Hotkey,
    additional: Hotkey[],
    expected: Hotkey[],
    lease?: LocalDataWriteLease,
  ): Promise<void> {
    return withLocalDataWrite(
      () =>
        invoke<void>("hotkey_replace_dictation_language_hotkeys", {
          primary,
          additional,
          expected,
        }),
      lease,
    );
  }
}
