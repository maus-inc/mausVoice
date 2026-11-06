import type { Hotkey } from "@maus-inc/types";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getHotkeyRepo } from "../../repos";
import { getAppState, produceAppState } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  DICTATE_HOTKEY,
  getAdditionalLanguageActionName,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { withLocalDataWrite } from "../../utils/local-data-write-gate";
import { applyReplacedStyleHotkeys } from "../../utils/style-hotkey";

type LanguageRow = { language: string; hotkeyKeys: string[] };

/** The language preference, primary hotkey and additional group are separate
 * writes. Publish only committed changes and synchronize them even on a later
 * failure; keep the dialog's draft available for retry. */
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

    const existing = Object.values(getAppState().hotkeyById);
    const primaryHotkey: Hotkey = {
      id:
        existing.find((item) => item.actionName === DICTATE_HOTKEY)?.id ??
        createId(),
      actionName: DICTATE_HOTKEY,
      keys: primary.hotkeyKeys,
    };
    const newAdditional: Hotkey[] = additional.map((row) => ({
      id: createId(),
      actionName: getAdditionalLanguageActionName(row.language),
      keys: row.hotkeyKeys,
    }));
    const repo = getHotkeyRepo();
    const savedPrimary = await repo.saveHotkey(primaryHotkey, lease);
    produceAppState((draft) => {
      draft.hotkeyById[savedPrimary.id] = savedPrimary;
      if (!draft.settings.hotkeyIds.includes(savedPrimary.id)) {
        draft.settings.hotkeyIds.push(savedPrimary.id);
      }
    }, lease);

    try {
      // This command replaces an arbitrary prefix in one SQLite transaction,
      // despite its historical style-specific name.
      const saved = await repo.replaceStyleHotkeys(
        ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
        newAdditional,
        lease,
      );
      produceAppState((draft) => {
        applyReplacedStyleHotkeys(
          draft,
          ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
          saved,
        );
      }, lease);
    } catch (error) {
      // The primary write has already committed. Do not leave native shortcuts
      // pointing at the old primary value when the group replacement fails.
      try {
        await syncHotkeyCombosToNative();
      } catch (syncError) {
        console.error(
          "Failed to synchronize the saved primary shortcut",
          syncError,
        );
      }
      throw error;
    }
    await syncHotkeyCombosToNative();
  });
};
