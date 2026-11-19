import type { Hotkey } from "@maus-inc/types";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getHotkeyRepo } from "../../repos";
import { getAppState, produceAppState } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  enqueueHotkeyWrite,
  optimisticHotkeyRevision,
  setOnboardingSavedHotkey,
} from "../../utils/hotkey-write-queue";
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

/** Publish the committed dictation group without undoing edits that landed
 * while the write was queued. When a newer optimistic revision exists for a
 * row, the committed value for that row loses: a diverged primary is left as
 * the editor published it, changed language rows keep their optimistic keys,
 * and rows an editor deleted are not resurrected by the replacement. */
const publishReplacedDictationHotkeys = (
  saved: Hotkey[],
  removedIds: string[],
  primary: Hotkey,
  beforePrimary: Hotkey | undefined,
  beforeAdditional: Hotkey[],
  revisions: { primary: number; additional: number },
  lease: LocalDataWriteLease | undefined,
): void => {
  const store = getAppState();
  const primaryNewer =
    optimisticHotkeyRevision(DICTATE_HOTKEY) !== revisions.primary;
  const additionalNewer =
    optimisticHotkeyRevision(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX) !==
    revisions.additional;
  const currentPrimary = Object.values(store.hotkeyById).find(
    (item) => item.actionName === DICTATE_HOTKEY,
  );
  const keepPrimary = primaryNewer && currentPrimary !== beforePrimary;
  const changedAdditional = new Set(
    additionalNewer
      ? Object.values(store.hotkeyById)
          .filter(
            (item) =>
              item.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX) &&
              !beforeAdditional.includes(item),
          )
          .map((item) => item.id)
      : [],
  );
  const deletedAdditional = new Set(
    additionalNewer
      ? beforeAdditional
          .filter((item) => !store.hotkeyById[item.id])
          .map((item) => item.id)
      : [],
  );
  const removal = removedIds.filter(
    (id) => !(keepPrimary && id === primary.id) && !changedAdditional.has(id),
  );
  const publishable = saved.filter(
    (item) =>
      !(keepPrimary && item.id === primary.id) &&
      // An optimistically edited row keeps its store value: it is already out
      // of the removal set, and republishing the committed keys here would
      // clobber the newer ones the editor just published.
      !changedAdditional.has(item.id) &&
      !deletedAdditional.has(item.id),
  );
  produceAppState((draft) => {
    applyReplacedHotkeys(draft, removal, publishable);
  }, lease);
};

/** The language preference, primary hotkey and additional group are separate
 * writes. Publish only committed changes and synchronize them even on a later
 * failure; keep the dialog's draft available for retry.
 *
 * The dictation group is written in one transaction: the primary `dictate` row,
 * the language rows the dialog edited and every other `dictate` row the
 * shortcuts dialog owns. Saving a language change therefore cannot delete a
 * second dictation shortcut the language dialog never displayed, and cannot
 * leave the primary saved while the group failed.
 *
 * The transaction runs on the shared hotkey write queue. Later editors publish
 * optimistically while it waits, so the store snapshot and the optimistic
 * revisions are captured before enqueuing and the publish refuses to replace
 * any row that moved on without it. */
export const saveDictationLanguageSettings = async (
  rows: LanguageRow[],
  currentLanguage: string,
  initialLanguage = currentLanguage,
  /** The group the dialog's rows were drafted from, read when it opened. */
  snapshot?: Hotkey[],
): Promise<void> => {
  const [primary, ...additional] = rows;
  if (!primary) throw new Error("A primary dictation language is required.");

  const before = Object.values(getAppState().hotkeyById);
  const beforePrimary = before.find(
    (item) => item.actionName === DICTATE_HOTKEY,
  );
  const beforeAdditional = before.filter((item) =>
    item.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX),
  );
  const primaryRevision = optimisticHotkeyRevision(DICTATE_HOTKEY);
  const additionalRevision = optimisticHotkeyRevision(
    ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  );

  await withLocalDataWrite((lease) =>
    enqueueHotkeyWrite(async () => {
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
      // The conflict check must assert the group the dialog's rows were
      // drafted from. Rereading it here would accept keys written after the
      // draft was taken and silently overwrite them; a shortcut added in
      // another dialog between opening and saving is reported instead.
      // The fresh read below still drives id reuse and untouched rows.
      const group = (await repo.listHotkeys())
        .filter(isDictationGroupRow)
        .sort(byId);
      const expectedGroup = snapshot
        ? snapshot.filter(isDictationGroupRow).sort(byId)
        : group;
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
          hotkey.actionName === DICTATE_HOTKEY &&
          hotkey.id !== primaryHotkey.id,
      );
      // Reuse the ids the store held when this write was queued: queued edits
      // and deletes still refer to them after the group is replaced.
      const availableIds = [...beforeAdditional];
      const languageRows: Hotkey[] = additional.map((row) => {
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
      const saved = [
        primaryHotkey,
        ...languageRows,
        ...untouchedDictationRows,
      ].sort(byId);

      await repo.replaceDictationLanguageHotkeys(
        primaryHotkey,
        [...languageRows, ...untouchedDictationRows],
        expectedGroup,
        lease,
      );
      setOnboardingSavedHotkey(primaryHotkey.id, primaryHotkey);

      publishReplacedDictationHotkeys(
        saved,
        group.map((hotkey) => hotkey.id),
        primaryHotkey,
        beforePrimary,
        beforeAdditional,
        { primary: primaryRevision, additional: additionalRevision },
        lease,
      );
      await syncHotkeyCombosToNative();
    }),
  );
};
