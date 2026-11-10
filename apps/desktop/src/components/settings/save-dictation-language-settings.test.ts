import { beforeEach, expect, it, vi } from "vitest";
import type { Hotkey } from "@maus-inc/types";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  replaceGroup: vi.fn(),
  sync: vi.fn(),
  language: vi.fn(),
  tones: vi.fn(),
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({
    listHotkeys: mocks.list,
    replaceDictationLanguageHotkeys: mocks.replaceGroup,
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
import {
  enqueueHotkeyWrite,
  markOptimisticHotkeyWrite,
} from "../../utils/hotkey-write-queue";
import { saveDictationLanguageSettings } from "./save-dictation-language-settings";

const oldPrimary = {
  id: "primary",
  actionName: "dictate",
  keys: ["A"],
} as Hotkey;
const secondDictation = {
  id: "second",
  actionName: "dictate",
  keys: ["S"],
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
    draft.hotkeyById.second = secondDictation;
    draft.hotkeyById.extra = oldAdditional;
    draft.settings.hotkeyIds = ["primary", "second", "extra"];
  });
  mocks.list.mockResolvedValue([oldPrimary, secondDictation, oldAdditional]);
  mocks.replaceGroup.mockResolvedValue(undefined);
  mocks.sync.mockResolvedValue(undefined);
});

it("writes the primary and the language rows in one group replacement", async () => {
  await saveDictationLanguageSettings(rows, "en");

  expect(mocks.replaceGroup).toHaveBeenCalledTimes(1);
  const [primary, additional, expected] = mocks.replaceGroup.mock.calls[0];
  expect(primary).toEqual({
    id: "primary",
    actionName: "dictate",
    keys: ["C"],
  });
  expect(additional.map((hotkey: Hotkey) => hotkey.actionName).sort()).toEqual([
    "additional-language:de",
    "dictate",
  ]);
  // The snapshot is the group as the database orders it, so a later comparison
  // cannot depend on the order the store happened to hold.
  expect(expected).toEqual(
    [oldPrimary, secondDictation, oldAdditional].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  );
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("keeps a second dictation shortcut the language dialog never displayed", async () => {
  await saveDictationLanguageSettings(rows, "en");

  const [, additional] = mocks.replaceGroup.mock.calls[0];
  expect(additional).toContainEqual(secondDictation);
  const shortcuts = Object.values(getAppState().hotkeyById);
  expect(shortcuts).toContainEqual(secondDictation);
  expect(
    shortcuts.filter((hotkey) => hotkey.actionName === "dictate"),
  ).toHaveLength(2);
  expect(getAppState().hotkeyById.extra).toBeUndefined();
  expect(shortcuts.map((hotkey) => hotkey.actionName).sort()).toEqual([
    "additional-language:de",
    "dictate",
    "dictate",
  ]);
});

it("publishes and synchronizes nothing when the group replacement fails", async () => {
  mocks.replaceGroup.mockRejectedValueOnce(new Error("group failed"));

  await expect(saveDictationLanguageSettings(rows, "en")).rejects.toThrow(
    "group failed",
  );

  expect(getAppState().hotkeyById.primary).toEqual(oldPrimary);
  expect(getAppState().hotkeyById.second).toEqual(secondDictation);
  expect(getAppState().hotkeyById.extra).toEqual(oldAdditional);
  expect(getAppState().settings.hotkeyIds).toEqual([
    "primary",
    "second",
    "extra",
  ]);
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
  expect(mocks.replaceGroup).not.toHaveBeenCalled();
  mocks.tones.mockResolvedValueOnce(undefined);
  await saveDictationLanguageSettings(rows, "en", "fr");
  expect(mocks.language).toHaveBeenCalledTimes(1);
  expect(mocks.tones).toHaveBeenCalledTimes(2);
  expect(mocks.replaceGroup).toHaveBeenCalledTimes(1);
});

it("does not overwrite a newer optimistic shortcut while a language save is pending", async () => {
  let finish!: () => void;
  mocks.replaceGroup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const saving = saveDictationLanguageSettings(rows, "en");
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  markOptimisticHotkeyWrite("dictate");
  produceAppState((draft) => {
    draft.hotkeyById.primary.keys = ["Z"];
  });
  finish();
  await saving;
  expect(getAppState().hotkeyById.primary.keys).toEqual(["Z"]);
});

it("publishes the later of two queued language saves", async () => {
  let finish!: () => void;
  mocks.replaceGroup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const first = saveDictationLanguageSettings(rows, "en");
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  const second = saveDictationLanguageSettings(
    [{ language: "en", hotkeyKeys: ["X"] }],
    "en",
  );
  finish();
  await Promise.all([first, second]);
  expect(getAppState().hotkeyById.primary.keys).toEqual(["X"]);
});

it("keeps an optimistic edit to a language the dialog also saves", async () => {
  // CodeAnt P2: the changed ID is in `saved` too (id reuse), so the committed
  // group must not republish its stale keys over the optimistic edit.
  let finish!: () => void;
  mocks.replaceGroup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const saving = saveDictationLanguageSettings(
    [
      { language: "en", hotkeyKeys: ["C"] },
      { language: "fr", hotkeyKeys: ["D"] },
    ],
    "en",
  );
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  markOptimisticHotkeyWrite(oldAdditional.actionName);
  produceAppState((draft) => {
    draft.hotkeyById.extra.keys = ["Z"];
  });
  finish();
  await saving;
  expect(getAppState().hotkeyById.extra.keys).toEqual(["Z"]);
  expect(
    Object.values(getAppState().hotkeyById).filter(
      (hotkey) => hotkey.actionName === oldAdditional.actionName,
    ),
  ).toHaveLength(1);
});

it("preserves a newer optimistic additional shortcut while publishing the saved group", async () => {
  let finish!: () => void;
  mocks.replaceGroup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const saving = saveDictationLanguageSettings(rows, "en");
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  markOptimisticHotkeyWrite(oldAdditional.actionName);
  produceAppState((draft) => {
    draft.hotkeyById.extra.keys = ["Z"];
  });
  finish();
  await saving;
  expect(getAppState().hotkeyById.extra.keys).toEqual(["Z"]);
  expect(
    Object.values(getAppState().hotkeyById).map((hotkey) => hotkey.actionName),
  ).toContain("additional-language:de");
});

it("keeps a newer optimistic deletion out of the saved group", async () => {
  let finish!: () => void;
  mocks.replaceGroup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const saving = saveDictationLanguageSettings(rows, "en");
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  markOptimisticHotkeyWrite(oldAdditional.actionName);
  produceAppState((draft) => {
    Reflect.deleteProperty(draft.hotkeyById, "extra");
    draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
      (id) => id !== "extra",
    );
  });
  finish();
  await saving;
  expect(getAppState().hotkeyById.extra).toBeUndefined();
  expect(getAppState().settings.hotkeyIds).not.toContain("extra");
  expect(
    Object.values(getAppState().hotkeyById).map((item) => item.actionName),
  ).toContain("additional-language:de");
});

it("preserves a concurrent deletion when the saved language remains in the group", async () => {
  let finish!: () => void;
  const persisted = new Map<string, Hotkey>();
  mocks.replaceGroup.mockImplementationOnce(
    (_primary: Hotkey, additional: Hotkey[]) =>
      new Promise<void>((resolve) => {
        finish = () => {
          persisted.clear();
          for (const hotkey of additional) persisted.set(hotkey.id, hotkey);
          resolve();
        };
      }),
  );
  const saving = saveDictationLanguageSettings(
    [
      { language: "en", hotkeyKeys: ["C"] },
      { language: "fr", hotkeyKeys: ["D"] },
    ],
    "en",
  );
  await vi.waitFor(() => expect(mocks.replaceGroup).toHaveBeenCalled());
  markOptimisticHotkeyWrite(oldAdditional.actionName);
  produceAppState((draft) => {
    Reflect.deleteProperty(draft.hotkeyById, oldAdditional.id);
    draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
      (id) => id !== oldAdditional.id,
    );
  });
  const deleting = enqueueHotkeyWrite(() => {
    persisted.delete(oldAdditional.id);
    return Promise.resolve();
  });
  finish();
  await Promise.all([saving, deleting]);
  expect(
    [...persisted.values()].filter(
      (hotkey) => hotkey.actionName === oldAdditional.actionName,
    ),
  ).toEqual([]);
  expect(
    Object.values(getAppState().hotkeyById).filter(
      (hotkey) => hotkey.actionName === oldAdditional.actionName,
    ),
  ).toEqual([]);
});
