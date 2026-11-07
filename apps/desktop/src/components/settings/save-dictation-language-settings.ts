import type { Hotkey } from "@maus-inc/types";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  DICTATE_HOTKEY,
  getAdditionalLanguageActionName,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import type { LocalDataWriteLease } from "../../utils/local-data-write-gate";
import { withLocalDataWrite } from "../../utils/local-data-write-gate";
import { applyReplacedHotkeys } from "../../utils/style-hotkey";

type LanguageRow = { language: string; hotkeyKeys: string[] };

/** A row of the dictation group: the primary `dictate` shortcut, an extra
 * `dictate` row the shortcuts dialog added, or an additional language. */
const isDictationGroupRow = (hotkey: Hotkey): boolean =>
  hotkey.actionName === DICTATE_HOTKEY ||
  hotkey.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX);

const byId = (left: Hotkey, right: Hotkey): number =>
  left.id.localeCompare(right.id);

/** Replace the dictation group in the store with what the database now holds.
 * The group is replaced as a whole, so rows the dialog never displayed -- an
 * extra `dictate` row, a language it removed -- cannot survive a save. */
const applyReplacedDictationHotkeys = (
  saved: Hotkey[],
  removedIds: Iterable<string>,
  lease: LocalDataWriteLease | undefined,
): void => {
  produceAppState(
    (draft) => applyReplacedHotkeys(draft, removedIds, saved),
    lease,
  );
};

/** The language preference, primary hotkey and additional group are separate
 * writes. Publish only committed changes and synchronize them even on a later
 * failure; keep the dialog's draft available for retry.
 *
 * The dictation group is written in one transaction: the primary `dictate` row,
 * the language rows the dialog edited and every other `dictate` row the
 * shortcuts dialog owns. Saving a language change therefore cannot delete a
 * second dictation shortcut the language dialog never displayed, and cannot
 * leave the primary saved while the group failed. */
export const saveDictationLanguageSettings = async (
  rows: LanguageRow[],
  currentLanguage: string,
  initialLanguage = currentLanguage,
): Promise<void> => {
  const [primary, ...additional] = rows;
  if (!primary) throw new Error("A primary dictation language is required.");

  await withLocalDataWrite(async (lease) => {
    if (primary.language !== currentLanguage) {
      await setPreferredLanguage(primary.language, lease, {
        showErrorToast: false,
      });
    }
    // A previous attempt may have saved the language before tone loading or a
    // later step failed. Retrying must refresh tones even if the store now
    // already reflects the requested language.
    if (
      primary.language !== currentLanguage ||
      primary.language !== initialLanguage
    ) {
      await loadTones();
    }

    const repo = getHotkeyRepo();
    // Read the group immediately before replacing it: the snapshot is what the
    // replacement asserts, so a shortcut added in another dialog between the
    // dialog opening and this save is reported instead of silently dropped.
    const group = (await repo.listHotkeys())
      .filter(isDictationGroupRow)
      .sort(byId);
    const existingPrimary = group.find(
      (hotkey) => hotkey.actionName === DICTATE_HOTKEY,
    );
    const primaryHotkey: Hotkey = {
      id: existingPrimary?.id ?? createId(),
      actionName: DICTATE_HOTKEY,
      keys: primary.hotkeyKeys,
    };
    const untouchedDictationRows = group.filter(
      (hotkey) =>
        hotkey.actionName === DICTATE_HOTKEY && hotkey.id !== primaryHotkey.id,
    );
    const languageRows: Hotkey[] = additional.map((row) => ({
      id: createId(),
      actionName: getAdditionalLanguageActionName(row.language),
      keys: row.hotkeyKeys,
    }));
    const saved = [
      primaryHotkey,
      ...languageRows,
      ...untouchedDictationRows,
    ].sort(byId);

    await repo.replaceDictationLanguageHotkeys(
      primaryHotkey,
      [...languageRows, ...untouchedDictationRows],
      group,
      lease,
    );

    applyReplacedDictationHotkeys(
      saved,
      group.map((hotkey) => hotkey.id),
      lease,
    );
    await syncHotkeyCombosToNative();
  });
};
