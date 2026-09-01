import { invoke } from "@tauri-apps/api/core";
import { AppState } from "../state/app.state";
import { useAppStore } from "../store";
import { getEffectiveStylingMode } from "./feature.utils";
import { getPlatform } from "./platform.utils";
import { getIsDictationUnlocked } from "./user.utils";

export const DICTATE_HOTKEY = "dictate";
export const AGENT_DICTATE_HOTKEY = "agent-dictate";
export const SWITCH_WRITING_STYLE_FORWARD_HOTKEY =
  "switch-writing-style-forward";
export const SWITCH_WRITING_STYLE_BACKWARD_HOTKEY =
  "switch-writing-style-backward";
export const CANCEL_TRANSCRIPTION_HOTKEY = "cancel-transcription";
export const OPEN_CHAT_HOTKEY = "open-chat";
export const ADD_TO_DICTIONARY_HOTKEY = "add-to-dictionary";
export const ADDITIONAL_LANGUAGE_HOTKEY_PREFIX = "additional-language:";
export const SWITCH_TO_STYLE_HOTKEY_PREFIX = "switch-to-style:";

type CompositorBinding = {
  actionName: string;
  keys: string[];
};

const STATIC_COMPOSITOR_TRIGGER_ACTIONS = [
  DICTATE_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  ADD_TO_DICTIONARY_HOTKEY,
];

const isCompositorTriggerAction = (actionName: string): boolean =>
  STATIC_COMPOSITOR_TRIGGER_ACTIONS.includes(actionName) ||
  actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX) ||
  actionName.startsWith(SWITCH_TO_STYLE_HOTKEY_PREFIX);

export const getAdditionalLanguageActionName = (language: string): string =>
  `${ADDITIONAL_LANGUAGE_HOTKEY_PREFIX}${language}`;

export const getAdditionalLanguageCode = (
  actionName: string,
): string | null => {
  if (!actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)) {
    return null;
  }

  const raw = actionName.slice(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX.length);
  return raw.length > 0 ? raw : null;
};

export const getSwitchToStyleActionName = (toneId: string): string =>
  `${SWITCH_TO_STYLE_HOTKEY_PREFIX}${toneId}`;

export const getSwitchToStyleToneId = (actionName: string): string | null => {
  if (!actionName.startsWith(SWITCH_TO_STYLE_HOTKEY_PREFIX)) {
    return null;
  }

  const raw = actionName.slice(SWITCH_TO_STYLE_HOTKEY_PREFIX.length);
  return raw.length > 0 ? raw : null;
};

export type SwitchToStyleEntry = {
  actionName: string;
  toneId: string;
  toneName: string;
  hotkeyCombos: string[][];
};

export const getSwitchToStyleEntries = (
  state: AppState,
): SwitchToStyleEntry[] =>
  Object.values(state.toneById)
    .filter((tone) => !tone.isDeprecated)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((tone) => ({
      actionName: getSwitchToStyleActionName(tone.id),
      toneId: tone.id,
      toneName: tone.name,
      hotkeyCombos: getHotkeyCombosForAction(
        state,
        getSwitchToStyleActionName(tone.id),
      ),
    }));

/**
 * Action-name prefixes for style-switch hotkeys. The hotkey spam filter may
 * debounce these while the pill is active. Kept in one place so the filter
 * (hotkey-filter.utils.ts) and the release wiring (AppSideEffects keys_held
 * handler) can't drift apart.
 */
export const STYLE_SWITCH_ACTION_PREFIXES: readonly string[] = [
  "switch-writing-style-",
  SWITCH_TO_STYLE_HOTKEY_PREFIX,
];

/**
 * Return the style-switch action names bound to the given physical key.
 *
 * Used to release the hotkey filter's "held" state when the physical key is
 * released — the previous wiring released only on *all* keys up, which never
 * happens during hold-to-talk dictation (the dictate key stays held), wedging
 * style switching after the first press.
 */
export const getStyleSwitchActionNamesForKey = (
  state: AppState,
  key: string,
): string[] => {
  const normalized = key.toLowerCase();
  // Include every configured action covered by the shared debounce prefixes,
  // plus built-ins which can resolve to platform defaults on macOS/Windows.
  // Linux has no default cycle bindings, so absent user configuration there is
  // correctly not releasable: it could not have triggered or become held.
  const isStyleSwitchAction = (actionName: string): boolean =>
    STYLE_SWITCH_ACTION_PREFIXES.some((prefix) =>
      actionName.toLowerCase().startsWith(prefix),
    );
  const actionNames = new Set(
    Object.keys(DEFAULT_HOTKEY_COMBOS).filter(isStyleSwitchAction),
  );
  for (const hotkey of Object.values(state.hotkeyById)) {
    if (isStyleSwitchAction(hotkey.actionName)) {
      actionNames.add(hotkey.actionName);
    }
  }
  return [...actionNames].filter((actionName) =>
    getHotkeyCombosForAction(state, actionName).some((combo) =>
      combo.some((comboKey) => comboKey.toLowerCase() === normalized),
    ),
  );
};

export const isHoldActionHotkey = (actionName: string): boolean => {
  return (
    actionName === DICTATE_HOTKEY ||
    actionName === AGENT_DICTATE_HOTKEY ||
    actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)
  );
};

const isModifierLikeKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("meta") ||
    lower.startsWith("control") ||
    lower.startsWith("shift") ||
    lower.startsWith("alt") ||
    lower.startsWith("option") ||
    lower.startsWith("function")
  );
};

export const isModifierOnlyCombo = (combo: string[]): boolean => {
  return combo.length > 0 && combo.every((key) => isModifierLikeKey(key));
};

const MODIFIER_SIDE_RE = /(Left|Right)$/i;

const appendSideLabel = (base: string, key: string): string => {
  const match = MODIFIER_SIDE_RE.exec(key);
  if (!match) return base;
  const side = match[1].charAt(0).toUpperCase();
  return `${base} ${side}`;
};

export const getPrettyKeyName = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower.startsWith("key")) {
    return key.slice(3).toUpperCase();
  }

  if (lower.startsWith("meta")) {
    return appendSideLabel(getPlatform() === "macos" ? "⌘" : "⊞", key);
  }

  if (lower.startsWith("control")) {
    return appendSideLabel(getPlatform() === "macos" ? "⌃" : "Ctrl", key);
  }

  if (lower.startsWith("shift")) {
    return appendSideLabel(getPlatform() === "macos" ? "⇧" : "Shift", key);
  }

  if (lower.startsWith("alt") || lower.startsWith("option")) {
    return appendSideLabel(getPlatform() === "macos" ? "⌥" : "Alt", key);
  }

  if (lower.startsWith("function")) {
    return "Fn";
  }

  if (key === "LeftArrow") return "←";
  if (key === "RightArrow") return "→";
  if (key === "UpArrow") return "↑";
  if (key === "DownArrow") return "↓";

  return key;
};

type PlatformHotkeyCombos = {
  macos: string[][];
  windows: string[][];
};

export const DEFAULT_HOTKEY_COMBOS: Record<string, PlatformHotkeyCombos> = {
  [DICTATE_HOTKEY]: {
    macos: [["Function"]],
    windows: [["MetaLeft", "ControlLeft"]],
  },
  [CANCEL_TRANSCRIPTION_HOTKEY]: {
    macos: [["Escape"]],
    windows: [["Escape"]],
  },
  [SWITCH_WRITING_STYLE_FORWARD_HOTKEY]: {
    macos: [["RightArrow"]],
    windows: [["RightArrow"]],
  },
  [SWITCH_WRITING_STYLE_BACKWARD_HOTKEY]: {
    macos: [["LeftArrow"]],
    windows: [["LeftArrow"]],
  },
};

export const getHasDefaultHotkeyForAction = (actionName: string): boolean => {
  return Boolean(DEFAULT_HOTKEY_COMBOS[actionName]);
};

export const getDefaultHotkeyCombosForAction = (
  actionName: string,
): string[][] => {
  const defaultCombos = DEFAULT_HOTKEY_COMBOS[actionName];
  if (defaultCombos) {
    if (getPlatform() === "macos") {
      return defaultCombos.macos;
    }
    if (getPlatform() === "windows") {
      return defaultCombos.windows;
    }
  }
  return [];
};

export const getHotkeyCombosForAction = (
  state: AppState,
  actionName: string,
): string[][] => {
  const combos = Object.values(state.hotkeyById)
    .filter((h) => h.actionName === actionName && h.keys.length > 0)
    .map((h) => h.keys);

  if (combos.length > 0) {
    return combos;
  }

  return getDefaultHotkeyCombosForAction(actionName);
};

export type AdditionalLanguageEntry = {
  actionName: string;
  language: string;
  hotkeyCombos: string[][];
};

export const getAdditionalLanguageEntries = (
  state: AppState,
): AdditionalLanguageEntry[] => {
  return Object.values(state.hotkeyById)
    .filter(
      (hotkey) =>
        hotkey &&
        hotkey.actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX),
    )
    .map((hotkey) => {
      const language = getAdditionalLanguageCode(hotkey.actionName);
      if (!language) {
        return null;
      }
      return {
        actionName: hotkey.actionName,
        language,
        hotkeyCombos: getHotkeyCombosForAction(state, hotkey.actionName),
      };
    })
    .filter((entry): entry is AdditionalLanguageEntry => Boolean(entry));
};

/**
 * Fire-style shortcuts (cancel/switch style) are handled on key release in TS and should not
 * be natively grabbed, so shared shortcuts like Cmd+Z keep working.
 */
const isActionGrabbable = (state: AppState, actionName: string): boolean => {
  if (actionName === CANCEL_TRANSCRIPTION_HOTKEY) {
    return state.activeRecordingMode !== null;
  }

  if (
    actionName === SWITCH_WRITING_STYLE_FORWARD_HOTKEY ||
    actionName === SWITCH_WRITING_STYLE_BACKWARD_HOTKEY
  ) {
    return (
      state.activeRecordingMode !== null &&
      getEffectiveStylingMode(state) === "manual"
    );
  }

  if (actionName === DICTATE_HOTKEY || actionName === AGENT_DICTATE_HOTKEY) {
    return getIsDictationUnlocked(state);
  }

  return true;
};

// Serializes native combo syncs. The store subscription in AppSideEffects
// fires this once per grab-relevant change, and those arrive in bursts while
// startup data loads — overlapping calls snapshot `getState()` at call time,
// so an older push could resolve last and leave the native listener grabbing
// a stale combo set. Chaining each run onto the previous one (and reading the
// store when the run actually starts, not when it was requested) guarantees
// the last applied set is always the latest state. A failed run must not
// break the chain for later callers, hence the separate caught `syncQueue`.
// The returned promise is the run itself (NOT `syncQueue`): callers like
// AppSideEffects, hotkey.actions and StyleHotkeysDialog deliberately catch
// rejections to surface native-grab failures — returning the caught queue
// value would silently swallow them.
let syncQueue: Promise<void> = Promise.resolve();

export const syncHotkeyCombosToNative = (): Promise<void> => {
  const run = syncQueue.then(() => syncHotkeyCombosToNativeNow());
  syncQueue = run.catch(() => undefined);
  return run;
};

const collectActionNames = (state: AppState): Set<string> => {
  const actionNames = new Set<string>();
  for (const hotkey of Object.values(state.hotkeyById)) {
    if (hotkey.keys.length > 0) {
      actionNames.add(hotkey.actionName);
    }
  }
  for (const name of Object.keys(DEFAULT_HOTKEY_COMBOS)) {
    actionNames.add(name);
  }
  return actionNames;
};

const collectCombosForAction = (
  state: AppState,
  actionName: string,
): { grabbable: string[][]; primaryNonModifier: string[] | null } => {
  const actionCombos = getHotkeyCombosForAction(state, actionName);
  const grabbable: string[][] = [];
  let primaryNonModifier: string[] | null = null;

  if (!isActionGrabbable(state, actionName)) {
    return { grabbable, primaryNonModifier };
  }

  for (const combo of actionCombos) {
    if (combo.length === 0) {
      continue;
    }
    // Modifier-only fire hotkeys (e.g. Cmd) must not be natively grabbed:
    // they need key-up handling so supersets like Cmd+Z still pass through.
    if (!isHoldActionHotkey(actionName) && isModifierOnlyCombo(combo)) {
      continue;
    }
    grabbable.push(combo);
    if (primaryNonModifier === null && !isModifierOnlyCombo(combo)) {
      primaryNonModifier = combo;
    }
  }
  return { grabbable, primaryNonModifier };
};

const syncHotkeyCombosToNativeNow = async (): Promise<void> => {
  const state = useAppStore.getState();
  const actionNames = collectActionNames(state);

  const combos: string[][] = [];
  const compositorBindings: CompositorBinding[] = [];

  for (const actionName of actionNames) {
    const { grabbable, primaryNonModifier } = collectCombosForAction(
      state,
      actionName,
    );
    combos.push(...grabbable);

    if (isCompositorTriggerAction(actionName) && primaryNonModifier) {
      compositorBindings.push({
        actionName,
        keys: primaryNonModifier,
      });
    }
  }

  await invoke("sync_hotkey_combos", { combos });

  if (state.hotkeyStrategy === "bridge") {
    await invoke("sync_compositor_hotkeys", { bindings: compositorBindings });
  }
};
