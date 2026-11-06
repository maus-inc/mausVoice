// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  load: vi.fn(),
  replace: vi.fn(),
  showError: vi.fn(),
  setLanguage: vi.fn(),
  loadTones: vi.fn(),
}));
vi.mock("../../actions/hotkey.actions", () => ({
  ensureHotkeysLoaded: mocks.ensure,
  loadHotkeys: mocks.load,
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showError,
}));
vi.mock("../../actions/tone.actions", () => ({ loadTones: mocks.loadTones }));
vi.mock("../../actions/user.actions", () => ({
  setPreferredLanguage: mocks.setLanguage,
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({ replaceDictationLanguageHotkeys: mocks.replace }),
}));
vi.mock("../../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/user.utils")>()),
  getMyUser: () => ({ preferredLanguage: "en" }),
  getDetectedSystemLocale: () => "en",
}));
vi.mock("../common/HotKey", () => ({
  HotKey: ({ value }: { value: string[] }) => <span>{value.join("+")}</span>,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { DictationLanguageDialog } from "./DictationLanguageDialog";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensure.mockResolvedValue(true);
  mocks.load.mockResolvedValue(undefined);
  mocks.replace.mockResolvedValue(undefined);
  mocks.setLanguage.mockResolvedValue(undefined);
  mocks.loadTones.mockResolvedValue(undefined);
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.dictationLanguageDialogOpen = true;
  state.settings.hotkeysStatus = "success";
  state.settings.hotkeyIds = ["primary", "fr"];
  state.hotkeyById = {
    primary: { id: "primary", actionName: "dictate", keys: ["Control"] },
    fr: { id: "fr", actionName: "additional-language:fr", keys: ["Alt", "F"] },
  };
  setAppState(state, true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
const render = () => act(async () => root.render(<DictationLanguageDialog />));

it("waits for loaded shortcuts before offering a save and snapshots the loaded state", async () => {
  const pending = deferred<boolean>();
  mocks.ensure.mockReturnValueOnce(pending.promise);
  await render();
  expect(button("Save").disabled).toBe(true);
  expect(mocks.replace).not.toHaveBeenCalled();
  setAppState((state) => ({
    hotkeyById: {
      ...state.hotkeyById,
      primary: { ...state.hotkeyById.primary, keys: ["Q"] },
    },
  }));
  await act(async () => {
    pending.resolve(true);
    await pending.promise;
  });
  expect(document.body.textContent).toContain("Q");
  await act(async () => button("Save").click());
  expect(mocks.replace).toHaveBeenCalledWith(
    expect.objectContaining({ id: "primary", keys: ["Q"] }),
    expect.arrayContaining([
      expect.objectContaining({ actionName: "additional-language:fr" }),
    ]),
    expect.arrayContaining([
      expect.objectContaining({ id: "primary", keys: ["Q"] }),
      expect.objectContaining({ id: "fr" }),
    ]),
  );
});

it("serializes same-turn saves and leaves the dialog open while saving", async () => {
  const pending = deferred<void>();
  mocks.replace.mockReturnValueOnce(pending.promise);
  await render();
  const save = button("Save");
  act(() => {
    save.click();
    save.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.replace).toHaveBeenCalledTimes(1);
  expect(button("Cancel").disabled).toBe(true);
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(false);
});

it("retains the dialog and the previous store state when the transaction fails", async () => {
  mocks.replace.mockRejectedValueOnce(new Error("disk failed"));
  await render();
  const before = getAppState().hotkeyById;
  await act(async () => button("Save").click());
  expect(mocks.showError).toHaveBeenCalled();
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
  expect(getAppState().hotkeyById).toEqual(before);
  expect(button("Save").disabled).toBe(false);
});

it("does not close a dialog reopened while an earlier save was pending", async () => {
  const pending = deferred<void>();
  mocks.replace.mockReturnValueOnce(pending.promise);
  await render();
  act(() => button("Save").click());
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () =>
    setAppState((state) => ({
      settings: { ...state.settings, dictationLanguageDialogOpen: false },
    })),
  );
  await act(async () =>
    setAppState((state) => ({
      settings: { ...state.settings, dictationLanguageDialogOpen: true },
    })),
  );
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
  expect(mocks.load).toHaveBeenCalledTimes(3);
});

it("reports concurrent shortcut edits without closing the dialog", async () => {
  mocks.replace.mockRejectedValueOnce("DICTATION_HOTKEYS_CHANGED");
  await render();
  await act(async () => button("Save").click());
  expect(mocks.showError).toHaveBeenCalledWith(
    "Shortcuts changed elsewhere. Reopen this dialog and try again.",
  );
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
});

it("offers retry when shortcut loading fails", async () => {
  mocks.ensure.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await render();
  expect(button("Save").disabled).toBe(true);
  await act(async () => button("Retry").click());
  expect(button("Save").disabled).toBe(false);
});

it("retries against the committed snapshot if refreshing after save fails", async () => {
  mocks.load
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      setAppState((state) => ({
        settings: { ...state.settings, hotkeysStatus: "error" },
      }));
    })
    .mockImplementationOnce(async () => {
      setAppState((state) => ({
        settings: { ...state.settings, hotkeysStatus: "success" },
      }));
    });
  await render();
  await act(async () => button("Save").click());
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
  const [primary, additional] = mocks.replace.mock.calls[0];
  await act(async () => button("Save").click());
  expect(mocks.replace.mock.calls[1][2]).toEqual([primary, ...additional]);
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(false);
});

it("does not close the dialog after unmount while a save is pending", async () => {
  const pending = deferred<void>();
  mocks.replace.mockReturnValueOnce(pending.promise);
  await render();
  await act(async () => {
    button("Save").click();
    await Promise.resolve();
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
});

it("carries a second dictate binding through the group replacement", async () => {
  setAppState((state) => ({
    settings: {
      ...state.settings,
      hotkeyIds: ["primary", "secondary", "fr"],
    },
    hotkeyById: {
      ...state.hotkeyById,
      secondary: {
        id: "secondary",
        actionName: "dictate",
        keys: ["Alt", "D"],
      },
    },
  }));
  await render();
  await act(async () => button("Save").click());

  const [primary, additional] = mocks.replace.mock.calls[0];
  expect(primary).toEqual(
    expect.objectContaining({ id: "primary", actionName: "dictate" }),
  );
  expect(additional).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "secondary",
        actionName: "dictate",
        keys: ["Alt", "D"],
      }),
    ]),
  );
});
