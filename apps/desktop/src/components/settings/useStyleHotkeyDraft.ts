import type { Hotkey, Tone } from "@maus-inc/types";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { ensureHotkeysLoaded, loadHotkeys } from "../../actions/hotkey.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { HOTKEY_CONFLICT_MESSAGE } from "../../utils/hotkey-conflict";
import {
  createReplacementIdAllocator,
  isHotkeyDialogCurrent,
  refreshHotkeysAndClose,
  runHotkeyDraftSave,
} from "./hotkey-draft-session";
import {
  getHotkeyCombosForAction,
  getSwitchToStyleActionName,
  SWITCH_TO_STYLE_HOTKEY_PREFIX,
} from "../../utils/keyboard.utils";

type StyleHotkeyRow = {
  toneId: string;
  toneName: string;
  actionName: string;
  keys: string[];
};

function snapshot(tones: Tone[]) {
  const state = useAppStore.getState();
  const hotkeys = Object.values(state.hotkeyById)
    .filter((hotkey) =>
      hotkey.actionName.startsWith(SWITCH_TO_STYLE_HOTKEY_PREFIX),
    )
    .map((hotkey) => ({ ...hotkey, keys: [...hotkey.keys] }));
  const rows = tones.map((tone) => {
    const actionName = getSwitchToStyleActionName(tone.id);
    return {
      toneId: tone.id,
      toneName: tone.name,
      actionName,
      keys: getHotkeyCombosForAction(state, actionName)[0] ?? [],
    };
  });
  return { hotkeys, rows };
}

function replacements(rows: StyleHotkeyRow[], expected: Hotkey[]): Hotkey[] {
  const nextId = createReplacementIdAllocator(expected);
  return rows
    .filter((row) => row.keys.length > 0)
    .map((row) => ({
      id: nextId(row.actionName),
      actionName: row.actionName,
      keys: row.keys,
    }));
}

export function useStyleHotkeyDraft(
  open: boolean,
  tones: Tone[],
  enabled: boolean,
) {
  const intl = useIntl();
  const nonce = useAppStore((state) => state.authSessionNonce);
  const uid = useAppStore((state) => state.auth?.uid ?? null);
  const [rows, setRows] = useState<StyleHotkeyRow[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);
  const generation = useRef(0);
  const expected = useRef<Hotkey[]>([]);
  useEffect(() => {
    const revision = ++generation.current;
    setReady(false);
    setFailed(false);
    setRows([]);
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        void loadHotkeys().catch(() => undefined);
        const loaded = await ensureHotkeysLoaded();
        if (cancelled || revision !== generation.current) return;
        if (!loaded) {
          setFailed(true);
          return;
        }
        const draft = snapshot(tones);
        expected.current = draft.hotkeys;
        setRows(draft.rows);
        setReady(true);
      } catch (error) {
        if (!cancelled && revision === generation.current) {
          setFailed(true);
          showErrorSnackbar(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (generation.current === revision) generation.current++;
    };
  }, [open, tones, nonce, uid, attempt]);

  const close = () => {
    if (saving.current) return;
    produceAppState((state) => {
      state.settings.styleHotkeysDialogOpen = false;
    });
  };
  const save = async () => {
    if (saving.current || !enabled || !ready) return;
    const revision = generation.current;
    const stillCurrent = () =>
      isHotkeyDialogCurrent(
        "styleHotkeysDialogOpen",
        revision,
        generation.current,
        nonce,
        uid,
      );
    await runHotkeyDraftSave(
      saving,
      setIsSaving,
      stillCurrent,
      () => intl.formatMessage(HOTKEY_CONFLICT_MESSAGE),
      async () => {
        if (!(await ensureHotkeysLoaded()) || !stillCurrent()) return;
        const saved = await getHotkeyRepo().replaceStyleHotkeys(
          SWITCH_TO_STYLE_HOTKEY_PREFIX,
          replacements(rows, expected.current),
          expected.current,
        );
        if (stillCurrent()) expected.current = saved;
        await refreshHotkeysAndClose(
          "styleHotkeysDialogOpen",
          nonce,
          uid,
          stillCurrent,
        );
      },
    );
  };
  return {
    rows,
    setRows,
    ready,
    failed,
    retry: () => setAttempt((n) => n + 1),
    isSaving,
    close,
    save,
  };
}
