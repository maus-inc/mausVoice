// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  replace: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({
    saveHotkey: mocks.save,
    replaceStyleHotkeys: mocks.replace,
  }),
}));
vi.mock("../../actions/user.actions", () => ({
  setPreferredLanguage: vi.fn(),
}));
vi.mock("../../actions/tone.actions", () => ({ loadTones: vi.fn() }));
vi.mock("../../utils/keyboard.utils", async (original) => ({
  ...(await original<typeof import("../../utils/keyboard.utils")>()),
  syncHotkeyCombosToNative: mocks.sync,
}));
import type { Hotkey } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { saveDictationLanguageSettings } from "./save-dictation-language-settings";

it("holds a local-data write lease across the entire shortcut save", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  let finish!: () => void;
  let started!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.save.mockImplementation((hotkey: Hotkey) => {
    started();
    return new Promise<Hotkey>((resolve) => {
      finish = () => resolve(hotkey);
    });
  });
  mocks.replace.mockImplementation(async (_prefix, hotkeys) => hotkeys);
  mocks.sync.mockResolvedValue(undefined);
  const saving = saveDictationLanguageSettings(
    [{ language: "en", hotkeyKeys: ["A"] }],
    "en",
  );
  await saveStarted;
  let drained = false;
  const clearing = beginLocalDataClear().then((release) => {
    drained = true;
    return release;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await saving;
  const release = await clearing;
  try {
    expect(drained).toBe(true);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  } finally {
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    release();
  }
});
