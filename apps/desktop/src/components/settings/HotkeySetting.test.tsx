// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  savePrimary: vi.fn(),
  delete: vi.fn(),
  sync: vi.fn(),
  defaults: vi.fn(),
  combos: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../../actions/hotkey.actions", () => ({
  saveHotkey: mocks.save,
  savePrimaryHotkey: mocks.savePrimary,
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({ deleteHotkey: mocks.delete }),
}));
vi.mock("../../utils/keyboard.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/keyboard.utils")>()),
  getDefaultHotkeyCombosForAction: mocks.defaults,
  getHotkeyCombosForAction: mocks.combos,
  syncHotkeyCombosToNative: mocks.sync,
}));
vi.mock("../common/HotKey", () => ({
  HotKey: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (keys: string[]) => void;
  }) => (
    <button onClick={() => onChange(["Alt", "Q"])}>
      {value.join("+") || "No hotkey"}
    </button>
  ),
}));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { HotkeySetting } from "./HotkeySetting";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
const render = async (
  enabled?: boolean,
  onEnabledChange?: (enabled: boolean) => void,
) => {
  await act(async () =>
    root.render(
      <HotkeySetting
        title="Dictation"
        description="Record"
        actionName="dictate"
        enabled={enabled}
        onEnabledChange={onEnabledChange}
      />,
    ),
  );
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaults.mockReturnValue([["Ctrl", "D"]]);
  mocks.combos.mockReturnValue([]);
  mocks.save.mockResolvedValue(undefined);
  mocks.savePrimary.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  mocks.sync.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows and edits a default without saving until changed", async () => {
  await render();
  expect(button("Ctrl+D")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => button("Ctrl+D").click());
  expect(mocks.savePrimary).toHaveBeenCalledWith("dictate", ["Alt", "Q"]);
  await act(async () => button("Add another").click());
  expect(mocks.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ actionName: "dictate", keys: [] }),
  );
});

it("reverts a changed primary and deletes an additional shortcut", async () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.hotkeyIds = ["first", "second"];
  state.hotkeyById = {
    first: { id: "first", actionName: "dictate", keys: ["Alt", "A"] },
    second: { id: "second", actionName: "dictate", keys: ["Alt", "B"] },
  };
  setAppState(state, true);
  await render();
  await act(async () => button("Revert to default hotkey").click());
  expect(mocks.save).toHaveBeenCalledWith({
    id: "first",
    actionName: "dictate",
    keys: ["Ctrl", "D"],
  });
  await act(async () => button("Delete hotkey").click());
  expect(mocks.delete).toHaveBeenCalledWith("second");
  expect(mocks.sync).toHaveBeenCalledOnce();
});

it("allows disabling a toggled shortcut without deleting it", async () => {
  const onEnabledChange = vi.fn();
  await render(true, onEnabledChange);
  expect(container.textContent).not.toContain("Add another");
  await act(async () => button("Disable hotkey").click());
  expect(onEnabledChange).toHaveBeenCalledWith(false);
  expect(mocks.delete).not.toHaveBeenCalled();
});

it("deletes a primary shortcut with no default", async () => {
  mocks.defaults.mockReturnValue([]);
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.hotkeyIds = ["first"];
  state.hotkeyById.first = {
    id: "first",
    actionName: "dictate",
    keys: ["Alt", "A"],
  };
  setAppState(state, true);
  await render();
  await act(async () => button("Delete hotkey").click());
  expect(mocks.delete).toHaveBeenCalledWith("first");
  expect(mocks.sync).toHaveBeenCalledOnce();
});

it("warns for case-insensitive subset overlaps with another action", async () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.hotkeyById.other = {
    id: "other",
    actionName: "other",
    keys: ["ctrl", "d", "shift"],
  };
  setAppState(state, true);
  mocks.combos.mockImplementation((_state, action: string) =>
    action === "dictate" ? [["Ctrl", "D"]] : [["ctrl", "d", "shift"]],
  );
  await render();
  expect(container.textContent).toContain(
    "This shortcut overlaps with another.",
  );
});

it("installs a default when enabling an unset optional shortcut", async () => {
  const onEnabledChange = vi.fn();
  await render(false, onEnabledChange);
  expect(container.textContent).not.toContain("Ctrl+D");
  const toggle = container.querySelector<HTMLInputElement>(
    'input[aria-label="Enable hotkey"]',
  );
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  expect(onEnabledChange).toHaveBeenCalledWith(true);
  expect(mocks.savePrimary).toHaveBeenCalledWith("dictate", ["Ctrl", "D"]);
});
