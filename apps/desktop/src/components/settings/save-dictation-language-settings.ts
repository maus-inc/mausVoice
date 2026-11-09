import type { Hotkey } from "@maus-inc/types";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getHotkeyRepo } from "../../repos";
import { getAppState, produceAppState } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  enqueueHotkeyWrite,
  optimisticHotkeyRevision,
} from "../../utils/hotkey-write-queue";
import {
  ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  DICTATE_HOTKEY,
  getAdditionalLanguageActionName,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import {
  withLocalDataWrite,
  type LocalDataWriteLease,
} from "../../utils/local-data-write-gate";
import { applyReplacedStyleHotkeys } from "../../utils/style-hotkey";

type LanguageRow = { language: string; hotkeyKeys: string[] };

const publishPrimary = (
  saved: Hotkey,
  before: Hotkey | undefined,
  revision: number,
  lease: LocalDataWriteLease,
) => {
  const current = Object.values(getAppState().hotkeyById).find(
    (item) => item.actionName === DICTATE_HOTKEY,
  );
  if (
    optimisticHotkeyRevision(DICTATE_HOTKEY) !== revision &&
    current !== before
  )
    return;
  produceAppState((draft) => {
    draft.hotkeyById[saved.id] = saved;
    if (!draft.settings.hotkeyIds.includes(saved.id))
      draft.settings.hotkeyIds.push(saved.id);
  }, lease);
};

const publishAdditional = (
  saved: Hotkey[],
  before: Hotkey[],
  revision: number,
  lease: LocalDataWriteLease,
) => {
  const hasNewer =
    optimisticHotkeyRevision(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX) !== revision;
  const changed = hasNewer
    ? Object.values(getAppState().hotkeyById).filter(
        (item) =>
          item.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX) &&
          !before.includes(item),
      )
    : [];
  const removed = hasNewer
    ? new Set(
        before
          .filter((item) => !getAppState().hotkeyById[item.id])
          .map((item) => item.id),
      )
    : new Set<string>();
  produceAppState((draft) => {
    applyReplacedStyleHotkeys(
      draft,
      ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
      saved.filter((item) => !removed.has(item.id)),
    );
    for (const item of changed) {
      draft.hotkeyById[item.id] = item;
      if (!draft.settings.hotkeyIds.includes(item.id))
        draft.settings.hotkeyIds.push(item.id);
    }
  }, lease);
};

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

  // Later editors publish optimistically while this queued transaction waits.
  // Do not let its committed result replace those newer values in the store.
  const before = Object.values(getAppState().hotkeyById);
  const primaryRevision = optimisticHotkeyRevision(DICTATE_HOTKEY);
  const additionalRevision = optimisticHotkeyRevision(
    ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  );

  await withLocalDataWrite((lease) =>
    enqueueHotkeyWrite(async () => {
      const beforePrimary = before.find(
        (item) => item.actionName === DICTATE_HOTKEY,
      );
      const beforeAdditional = before.filter((item) =>
        item.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX),
      );
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
      // Queued edits and deletes still refer to these IDs after the group is replaced.
      const availableIds = [...beforeAdditional];
      const newAdditional: Hotkey[] = additional.map((row) => {
        const actionName = getAdditionalLanguageActionName(row.language);
        const index = availableIds.findIndex(
          (item) => item.actionName === actionName,
        );
        const existing =
          index < 0 ? undefined : availableIds.splice(index, 1)[0];
        return {
          id: existing?.id ?? createId(),
          actionName,
          keys: row.hotkeyKeys,
        };
      });
      const repo = getHotkeyRepo();
      const savedPrimary = await repo.saveHotkey(primaryHotkey, lease);
      publishPrimary(savedPrimary, beforePrimary, primaryRevision, lease);

      try {
        // This command replaces an arbitrary prefix in one SQLite transaction,
        // despite its historical style-specific name.
        const saved = await repo.replaceStyleHotkeys(
          ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
          newAdditional,
          lease,
        );
        publishAdditional(saved, beforeAdditional, additionalRevision, lease);
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
    }),
  );
};
