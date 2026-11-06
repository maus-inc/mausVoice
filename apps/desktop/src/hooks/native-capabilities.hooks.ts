import { invoke } from "@tauri-apps/api/core";
import type { HotkeyStrategy, PasteKeybindSupport } from "../state/app.state";
import { produceAppState } from "../store";
import { useAsyncEffect } from "./async.hooks";

/** Probe native capabilities without committing into a retired component. */
export function useNativeCapabilities() {
  useAsyncEffect(async (isCancelled) => {
    const [strategy, appDetection, pasteKeybinds] = await Promise.all([
      invoke<HotkeyStrategy>("get_hotkey_strategy"),
      invoke<boolean>("supports_app_detection"),
      invoke<PasteKeybindSupport>("supports_paste_keybinds"),
    ]);
    if (isCancelled()) return;
    produceAppState((draft) => {
      draft.hotkeyStrategy = strategy;
      draft.supportsAppDetection = appDetection;
      draft.supportsPasteKeybinds = pasteKeybinds;
    });
  }, []);
}
