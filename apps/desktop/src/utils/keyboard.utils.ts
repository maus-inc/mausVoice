import { invoke } from "@tauri-apps/api/core";
import {
  AppState,
  type HotkeyStrategy,
  type KeyboardListenerHealth,
} from "../state/app.state";
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

const getAdditionalLanguageCode = (actionName: string): string | null => {
  if (!actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)) {
    return null;
  }

  const raw = actionName.slice(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX.length);
  return raw.length > 0 ? raw : null;
};

export const getSwitchToStyleActionName = (toneId: string): string =>
  `${SWITCH_TO_STYLE_HOTKEY_PREFIX}${toneId}`;

/**
 * Every platform the app builds for, so a default cannot be added for one and
 * forgotten for another.
 *
 * `linux` was missing from this type and from the table below, and the lookup
 * had no branch for it either: on Linux every shortcut that ships with a
 * default came up unbound, which is the one platform where the person is least
 * likely to guess what the key should be. Listing the platforms exhaustively
 * makes the next default a compile error until it is answered for all three.
 *
 * Not `Record<Platform, …>`: `Platform` includes `unknown`, which is the
 * absence of an answer rather than a platform to answer for.
 */
type PlatformHotkeyCombos = {
  macos: string[][];
  windows: string[][];
  linux: string[][];
};

const DEFAULT_HOTKEY_COMBOS: Record<string, PlatformHotkeyCombos> = {
  [DICTATE_HOTKEY]: {
    macos: [["Function"]],
    windows: [["MetaLeft", "ControlLeft"]],
    // Compositor bridges cannot register a modifier-only shortcut. Include a
    // regular key so the Linux default works on both Wayland and X11.
    linux: [["ControlLeft", "AltLeft", "Space"]],
  },
  [CANCEL_TRANSCRIPTION_HOTKEY]: {
    macos: [["Escape"]],
    windows: [["Escape"]],
    linux: [["Escape"]],
  },
  [SWITCH_WRITING_STYLE_FORWARD_HOTKEY]: {
    macos: [["RightArrow"]],
    windows: [["RightArrow"]],
    linux: [["RightArrow"]],
  },
  [SWITCH_WRITING_STYLE_BACKWARD_HOTKEY]: {
    macos: [["LeftArrow"]],
    windows: [["LeftArrow"]],
    linux: [["LeftArrow"]],
  },
};

export const getDefaultHotkeyCombosForAction = (
  actionName: string,
): string[][] => {
  const defaultCombos = DEFAULT_HOTKEY_COMBOS[actionName];
  if (!defaultCombos) {
    return [];
  }

  const platform = getPlatform();
  // `unknown` is the absence of a platform, not a third case to guess at, so it
  // is the one answer that stays empty.
  return platform === "unknown" ? [] : defaultCombos[platform];
};

export const getHotkeyCombosForAction = (
  state: AppState,
  actionName: string,
): string[][] => {
  const configured = Object.values(state.hotkeyById).filter(
    (hotkey) => hotkey.actionName === actionName,
  );
  // An explicit empty binding is a cleared shortcut, not a missing record.
  // Only a genuinely unconfigured action inherits the platform default.
  return configured.length > 0
    ? configured
        .filter((hotkey) => hotkey.keys.length > 0)
        .map((hotkey) => hotkey.keys)
    : getDefaultHotkeyCombosForAction(actionName);
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

const isHoldActionHotkey = (actionName: string): boolean => {
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
  // `match[1]` is the only capture group and it is non-optional in the pattern,
  // so a successful `exec` always yields it. Reading it through `?.[1]` and
  // bailing on `undefined` keeps that fact explicit instead of asserting it.
  const side = MODIFIER_SIDE_RE.exec(key)?.[1];
  if (side === undefined) return base;
  return `${base} ${side.charAt(0).toUpperCase()}`;
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

export type KeycapLegend = {
  /** The glyph or word on the face. */
  label: string;
  /** Side of the board the key sits on, stacked above the label. */
  sublabel?: string;
};

/**
 * Legend for a key drawn on a keycap.
 *
 * A modifier with a side reads as "Left" stacked over the glyph rather than as
 * "Shift L" on one line: the side label is small and sits above the symbol, and
 * the inline form reads like two separate keys.
 */
const KEYCAP_LABELS: Readonly<Record<string, string>> = {
  Space: "SPC",
  Escape: "Esc",
  "⌘": "Cmd",
  "⊞": "Win",
  "⌃": "Ctrl",
  "⌥": "Alt",
  Shift: "⇧",
};

const keycapLabel = (pretty: string): string =>
  Object.hasOwn(KEYCAP_LABELS, pretty) ? KEYCAP_LABELS[pretty] : pretty;

/**
 * Health states in which a listener exists and is on its way to publishing keys.
 *
 * The two proven states are the steady ones: the grab path is alive, or the
 * listen fallback took over and still reports keys.
 *
 * `connected` and `fallback_starting` join them because a child is running and
 * no failure has been reported. `connected` is emitted by the child in shared
 * setup, before its platform loop installs the hook, so a key pressed in that
 * window is not seen yet. `fallback_starting` is the child already inside
 * `rdev::listen()`. Both last until the hook installs, until the child reports
 * `grab_failed`, or until the grace window closes, which is sub-second in the
 * ordinary case and repeats after every restart, wake, unlock and elevation
 * relaunch.
 *
 * The distinction matters for what reads this set. A stored preference, such as
 * the pill-locate setting, is offered here: the gesture cannot fire in the
 * sub-second before the hook installs because there are no keys to see, and
 * hiding a stored setting for that window is the defect that made the row look
 * missing on Windows. A one-shot action must not treat these two as proof, and
 * the failure notice does not: it uses `PROVEN_HEALTH`.
 *
 * Every other state means no child is publishing keys: `starting` has no child
 * yet, `grab_failed` is the moment between a failed hook and the listen
 * fallback, and `failed` and `stopped` have none. Something built on a global
 * stream must not claim to work in any of them.
 */
const DELIVERING_HEALTH: ReadonlySet<KeyboardListenerHealth> = new Set([
  "connected",
  "healthy_grab",
  "fallback_starting",
  "degraded_listen_fallback",
]);

/**
 * Health states that have proven a key path alive, not merely started one.
 *
 * The failure notice resets on these rather than on every delivering state:
 * `connected` reports the same child that was just declared dead a moment
 * earlier, so resetting there would let a child that keeps reconnecting and
 * dying re-raise no more than one notice per flap. Proof is the signal that the
 * episode is over.
 */
const PROVEN_HEALTH: ReadonlySet<KeyboardListenerHealth> = new Set([
  "healthy_grab",
  "degraded_listen_fallback",
]);

/** Whether the native listener may be publishing key snapshots right now. */
export const listenerDeliversKeys = (health: KeyboardListenerHealth): boolean =>
  DELIVERING_HEALTH.has(health);

/** Whether the native listener has proven a key path alive. */
export const listenerIsProvenHealthy = (
  health: KeyboardListenerHealth,
): boolean => PROVEN_HEALTH.has(health);

/**
 * Whether this build is receiving a global key stream right now.
 *
 * The strategy says whether a global source exists at all: macOS, Windows and
 * Linux X11 run the native listener, while a Wayland session runs the
 * compositor bridge instead, which registers chords and publishes no key
 * stream. Health says whether that source is publishing snapshots, which is the
 * only thing a gesture with no window focus can be detected from.
 *
 * Both halves are asked in one place because the answer is read in two: the
 * settings row decides whether to offer the gesture, and the detector decides
 * whether to watch for it. Two spellings of the same rule drift, and the pair
 * that disagreed is what advertised a gesture on a dead listener and then hid
 * one that was still arriving.
 */
export const globalKeyStreamIsLive = (
  strategy: HotkeyStrategy | null,
  health: KeyboardListenerHealth,
): boolean => strategy === "listener" && listenerDeliversKeys(health);

/**
 * Applies the startup health seed, unless a health event landed while the read
 * was pending.
 *
 * The seed exists because events emitted before the subscription registered are
 * lost, and the store would sit at its initial `stopped`. A seed that lands after
 * such an event would replace the newer value with an older snapshot, and the
 * native side does not repeat an unchanged state, so the stale value would stay
 * until the next transition, leaving a live listener reading as not live.
 *
 * The check and the write happen in one synchronous block, so no event callback
 * can slip in between them and be overwritten by the value it replaced.
 */
export const seedListenerHealth = async (
  readHealth: () => Promise<KeyboardListenerHealth>,
  hasNewerEvent: () => boolean,
  apply: (health: KeyboardListenerHealth) => void,
): Promise<void> => {
  const health = await readHealth();
  if (hasNewerEvent()) {
    return;
  }
  apply(health);
};

export const getKeycapLegend = (key: string): KeycapLegend => {
  const side = MODIFIER_SIDE_RE.exec(key)?.[1];
  if (side === undefined || !isModifierLikeKey(key))
    return { label: keycapLabel(getPrettyKeyName(key)) };
  const base = getPrettyKeyName(key.slice(0, -side.length));
  return {
    label: keycapLabel(base),
    sublabel: side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(),
  };
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
        // Rows represent individual bindings, even when several use the same
        // language. Looking up all combos by action would give each row the
        // first binding and silently overwrite the others on the next save.
        hotkeyCombos: hotkey.keys.length > 0 ? [hotkey.keys] : [],
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
