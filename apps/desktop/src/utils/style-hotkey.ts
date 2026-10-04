import type { AppState } from "../state/app.state";
import type { Hotkey } from "@maus-inc/types";

/**
 * Replaces every style hotkey (those whose `actionName` starts with `prefix`)
 * with `saved` in a single, deterministic store mutation. This is the pure core
 * of the style-hotkey "save" flow (previously an inline `produceAppState`
 * block in `StyleHotkeysDialog`). Extracting it makes the delete-all /
 * re-registration behavior unit-testable without the side-effectful IPC
 * (`hotkey_replace_style_hotkeys`) and native sync that wrap it.
 *
 * Behavior (mirrors the original inline block exactly):
 *  - all hotkeys under `prefix` are removed from `hotkeyById` and `hotkeyIds`;
 *  - `saved` is registered into `hotkeyById` and appended to `hotkeyIds`
 *    (idempotent: an id already present is not appended twice).
 */
export const applyReplacedStyleHotkeys = (
  draft: AppState,
  prefix: string,
  saved: Hotkey[],
): void => {
  const oldStyleIds = new Set(
    Object.values(draft.hotkeyById)
      .filter((hotkey) => hotkey.actionName.startsWith(prefix))
      .map((hotkey) => hotkey.id),
  );
  for (const id of oldStyleIds) {
    delete draft.hotkeyById[id];
  }
  draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
    (id) => !oldStyleIds.has(id),
  );
  for (const hotkey of saved) {
    draft.hotkeyById[hotkey.id] = hotkey;
    if (!draft.settings.hotkeyIds.includes(hotkey.id)) {
      draft.settings.hotkeyIds.push(hotkey.id);
    }
  }
};
