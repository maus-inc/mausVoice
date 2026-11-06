// @vitest-environment jsdom
import type { AppTarget } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  speed: vi.fn(),
  paste: vi.fn(),
  method: vi.fn(),
}));
vi.mock("../../actions/app-target.actions", () => ({
  setAppTargetTypingSpeed: mocks.speed,
  setAppTargetPasteKeybind: mocks.paste,
  setAppTargetInsertionMethod: mocks.method,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../common/StorageImage", () => ({
  StorageImage: ({ alt }: { alt: string }) => createElement("img", { alt }),
}));
vi.mock("../common/ElasticSlider", () => ({
  ElasticSlider: ({
    value,
    onCommit,
  }: {
    value: number;
    onCommit: (value: number) => void;
  }) =>
    createElement(
      "button",
      { "data-slider-value": value, onClick: () => onCommit(12) },
      "Slider",
    ),
}));
import { AppKeybindingsDialog } from "./AppKeybindingsDialog";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
const target: AppTarget = {
  id: "editor",
  name: "Editor",
  createdAt: "2026-01-01",
  toneId: null,
  iconPath: null,
  pasteKeybind: null,
  insertionMethod: null,
  typingSpeedMs: null,
};
beforeEach(async () => {
  vi.clearAllMocks();
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.appKeybindingsDialogOpen = true;
  state.appTargetById = { editor: target };
  setAppState(state, true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(AppKeybindingsDialog)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

it("shows a paste binding for an app that inherits the paste default", () => {
  expect(document.body.textContent).toContain("Editor");
  expect(document.body.textContent).toContain("Paste binding");
  expect(document.body.textContent).not.toContain("Simulated typing speed");
});

it("toggles the app typing speed between its inherited and explicit values", async () => {
  await act(async () =>
    produceAppState((draft) => {
      draft.appTargetById.editor.insertionMethod = "type";
    }),
  );
  expect(document.body.textContent).toContain("Simulated typing speed");
  expect(document.body.textContent).not.toContain("Paste binding");
  const useDefault = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(useDefault?.checked).toBe(true);
  await act(async () => useDefault?.click());
  expect(mocks.speed).toHaveBeenCalledWith("editor", 5);
  await act(async () =>
    produceAppState((draft) => {
      draft.appTargetById.editor.typingSpeedMs = 7;
    }),
  );
  expect(useDefault?.checked).toBe(false);
  const slider = document.querySelector<HTMLButtonElement>(
    'button[data-slider-value="7"]',
  );
  expect(slider).not.toBeNull();
  await act(async () => slider?.click());
  expect(mocks.speed).toHaveBeenLastCalledWith("editor", 12);
  await act(async () => useDefault?.click());
  expect(mocks.speed).toHaveBeenLastCalledWith("editor", null);
});

it("saves a per-app insertion method and can return to the inherited default", async () => {
  const openRowMenu = async () => {
    const menus = [
      ...document.querySelectorAll<HTMLElement>('[role="combobox"]'),
    ];
    const rowMenu = menus[2];
    expect(rowMenu).toBeDefined();
    await act(async () =>
      rowMenu.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
  };
  await openRowMenu();
  const choose = async (label: string) => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === label);
    expect(option).toBeDefined();
    await act(async () => option?.click());
  };
  await choose("Simulated typing");
  expect(mocks.method).toHaveBeenCalledWith("editor", "type");
  await act(async () =>
    produceAppState((draft) => {
      draft.appTargetById.editor.insertionMethod = "type";
    }),
  );
  await openRowMenu();
  await choose("Use default ({method})");
  expect(mocks.method).toHaveBeenLastCalledWith("editor", null);
});
