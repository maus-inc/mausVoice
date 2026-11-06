import type { Hotkey } from "@maus-inc/types";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { ensureHotkeysLoaded, loadHotkeys } from "../../actions/hotkey.actions";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { getHotkeyRepo } from "../../repos";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { HOTKEY_CONFLICT_MESSAGE } from "../../utils/hotkey-conflict";
import {
  ADDITIONAL_LANGUAGE_HOTKEY_PREFIX,
  DICTATE_HOTKEY,
  getAdditionalLanguageActionName,
  getAdditionalLanguageEntries,
  getHotkeyCombosForAction,
} from "../../utils/keyboard.utils";
import { getDetectedSystemLocale, getMyUser } from "../../utils/user.utils";
import {
  createReplacementIdAllocator,
  isHotkeyDialogCurrent,
  refreshHotkeysAndClose,
  runHotkeyDraftSave,
} from "./hotkey-draft-session";

type LanguageRow = {
  rowId: string;
  language: string;
  hotkeyKeys: string[];
};

function readDraft() {
  const state = useAppStore.getState();
  const hotkeys = Object.values(state.hotkeyById)
    .filter(
      (hotkey) =>
        hotkey.actionName === DICTATE_HOTKEY ||
        hotkey.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX),
    )
    .map((hotkey) => ({ ...hotkey, keys: [...hotkey.keys] }));
  const dictateHotkeys = hotkeys.filter(
    (hotkey) => hotkey.actionName === DICTATE_HOTKEY,
  );
  // The dialog edits one combination per language. Dictation can hold more than
  // one row, and the editor only shows the first, so the rest travel back
  // untouched instead of being deleted by the group replacement.
  const editedId = dictateHotkeys.find((hotkey) => hotkey.keys.length > 0)?.id;
  const extraPrimaryHotkeys = dictateHotkeys.filter(
    (hotkey) => hotkey.id !== editedId,
  );
  const rows: LanguageRow[] = [
    {
      rowId: createId(),
      language:
        getMyUser(state)?.preferredLanguage ?? getDetectedSystemLocale(),
      hotkeyKeys: getHotkeyCombosForAction(state, DICTATE_HOTKEY)[0] ?? [],
    },
    ...getAdditionalLanguageEntries(state).map((entry) => ({
      rowId: createId(),
      language: entry.language,
      hotkeyKeys: entry.hotkeyCombos[0] ?? [],
    })),
  ];
  return { hotkeys, rows, extraPrimaryHotkeys };
}

async function persistDraft(
  rows: LanguageRow[],
  expected: Hotkey[],
  extraPrimaryHotkeys: Hotkey[],
  stillCurrent: () => boolean,
): Promise<Hotkey[] | null> {
  const [primaryRow, ...additionalRows] = rows;
  const state = useAppStore.getState();
  const currentLanguage =
    getMyUser(state)?.preferredLanguage ?? getDetectedSystemLocale();
  if (primaryRow.language !== currentLanguage) {
    await setPreferredLanguage(primaryRow.language);
    if (!stillCurrent()) return null;
    await loadTones();
    if (!stillCurrent()) return null;
  }
  const nextId = createReplacementIdAllocator(expected);
  const primary: Hotkey = {
    id: nextId(DICTATE_HOTKEY),
    actionName: DICTATE_HOTKEY,
    keys: primaryRow.hotkeyKeys,
  };
  const additional: Hotkey[] = [
    ...extraPrimaryHotkeys.map((hotkey) => ({
      id: nextId(DICTATE_HOTKEY),
      actionName: DICTATE_HOTKEY,
      keys: [...hotkey.keys],
    })),
    ...additionalRows.map((row) => {
      const actionName = getAdditionalLanguageActionName(row.language);
      return { id: nextId(actionName), actionName, keys: row.hotkeyKeys };
    }),
  ];
  await getHotkeyRepo().replaceDictationLanguageHotkeys(
    primary,
    additional,
    expected,
  );
  return [primary, ...additional];
}

function canSaveDraft(
  saving: boolean,
  ready: boolean,
  rows: LanguageRow[],
): boolean {
  return !saving && ready && rows.length > 0;
}

export function useDictationLanguageDraft(open: boolean) {
  const intl = useIntl();
  const authNonce = useAppStore((state) => state.authSessionNonce);
  const authUid = useAppStore((state) => state.auth?.uid ?? null);
  const [rows, setRows] = useState<LanguageRow[]>([]);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);
  const dialogGeneration = useRef(0);
  const expectedHotkeys = useRef<Hotkey[]>([]);
  const extraPrimary = useRef<Hotkey[]>([]);

  useEffect(() => {
    const generation = ++dialogGeneration.current;
    setReady(false);
    setRows([]);
    setLoadFailed(false);
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        // Refresh on each opening so an earlier or another window's save is
        // reflected before the editor snapshots its rows.
        void loadHotkeys().catch(() => undefined);
        const loaded = await ensureHotkeysLoaded();
        if (cancelled || generation !== dialogGeneration.current) return;
        if (!loaded) {
          setLoadFailed(true);
          return;
        }
        const draft = readDraft();
        expectedHotkeys.current = draft.hotkeys;
        extraPrimary.current = draft.extraPrimaryHotkeys;
        setRows(draft.rows);
        setReady(true);
      } catch (error) {
        if (!cancelled && generation === dialogGeneration.current) {
          setLoadFailed(true);
          showErrorSnackbar(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (dialogGeneration.current === generation) dialogGeneration.current++;
    };
  }, [open, authNonce, authUid, attempt]);

  const handleSave = async () => {
    if (!canSaveDraft(saving.current, ready, rows)) return;
    const generation = dialogGeneration.current;
    const stillCurrent = () =>
      isHotkeyDialogCurrent(
        "dictationLanguageDialogOpen",
        generation,
        dialogGeneration.current,
        authNonce,
        authUid,
      );
    await runHotkeyDraftSave(
      saving,
      setIsSaving,
      stillCurrent,
      () => intl.formatMessage(HOTKEY_CONFLICT_MESSAGE),
      async () => {
        if (!(await ensureHotkeysLoaded()) || !stillCurrent()) return;
        const savedHotkeys = await persistDraft(
          rows,
          expectedHotkeys.current,
          extraPrimary.current,
          stillCurrent,
        );
        if (!savedHotkeys) return;
        if (stillCurrent()) expectedHotkeys.current = savedHotkeys;
        await refreshHotkeysAndClose(
          "dictationLanguageDialogOpen",
          authNonce,
          authUid,
          stillCurrent,
        );
      },
    );
  };

  return {
    rows,
    setRows,
    ready,
    loadFailed,
    setAttempt,
    isSaving,
    saving,
    handleSave,
  };
}
