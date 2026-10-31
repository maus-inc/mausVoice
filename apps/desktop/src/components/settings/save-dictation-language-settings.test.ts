import { beforeEach, expect, it, vi } from "vitest";
import type { Hotkey } from "@maus-inc/types";
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  replace: vi.fn(),
  sync: vi.fn(),
  language: vi.fn(),
  tones: vi.fn(),
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({
    saveHotkey: mocks.save,
    replaceStyleHotkeys: mocks.replace,
  }),
}));
vi.mock("../../actions/user.actions", () => ({
  setPreferredLanguage: mocks.language,
}));
vi.mock("../../actions/tone.actions", () => ({ loadTones: mocks.tones }));
vi.mock("../../utils/local-data-write-gate", async (original) => ({
  ...(await original<typeof import("../../utils/local-data-write-gate")>()),
  withLocalDataWrite: (fn: (lease: undefined) => Promise<void>) =>
    fn(undefined),
}));
vi.mock("../../utils/keyboard.utils", async (original) => ({
  ...(await original<typeof import("../../utils/keyboard.utils")>()),
  syncHotkeyCombosToNative: mocks.sync,
}));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { saveDictationLanguageSettings } from "./save-dictation-language-settings";

const oldPrimary = {
  id: "primary",
  actionName: "dictate",
  keys: ["A"],
} as Hotkey;
const oldAdditional = {
  id: "extra",
  actionName: "additional-language:fr",
  keys: ["B"],
} as Hotkey;
const rows = [
  { language: "en", hotkeyKeys: ["C"] },
  { language: "de", hotkeyKeys: ["D"] },
];
beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.hotkeyById.primary = oldPrimary;
    draft.hotkeyById.extra = oldAdditional;
    draft.settings.hotkeyIds = ["primary", "extra"];
  });
  mocks.save.mockImplementation(async (hotkey) => hotkey);
  mocks.replace.mockImplementation(async (_prefix, hotkeys) => hotkeys);
  mocks.sync.mockResolvedValue(undefined);
});
it("publishes only the primary write when transactional group replacement fails", async () => {
  mocks.replace.mockRejectedValueOnce(new Error("group failed"));
  await expect(saveDictationLanguageSettings(rows, "en")).rejects.toThrow(
    "group failed",
  );
  expect(getAppState().hotkeyById.primary.keys).toEqual(["C"]);
  expect(getAppState().hotkeyById.extra).toEqual(oldAdditional);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await saveDictationLanguageSettings(rows, "en");
  expect(getAppState().hotkeyById.extra).toBeUndefined();
  expect(
    Object.values(getAppState().hotkeyById).map((hotkey) => hotkey.actionName),
  ).toContain("additional-language:de");
});
it("does not publish or replace additional shortcuts if the primary save fails", async () => {
  mocks.save.mockRejectedValueOnce(new Error("primary failed"));
  await expect(saveDictationLanguageSettings(rows, "en")).rejects.toThrow(
    "primary failed",
  );
  expect(getAppState().hotkeyById.primary).toEqual(oldPrimary);
  expect(getAppState().hotkeyById.extra).toEqual(oldAdditional);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("retries tone loading after the preferred language was already saved", async () => {
  mocks.tones.mockRejectedValueOnce(new Error("tones unavailable"));
  await expect(saveDictationLanguageSettings(rows, "fr", "fr")).rejects.toThrow(
    "tones unavailable",
  );
  expect(mocks.language).toHaveBeenCalledWith("en", undefined, {
    showErrorToast: false,
  });
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.tones.mockResolvedValueOnce(undefined);
  await saveDictationLanguageSettings(rows, "en", "fr");
  expect(mocks.language).toHaveBeenCalledTimes(1);
  expect(mocks.tones).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledTimes(1);
});
