// @vitest-environment jsdom
import { isHotkeyCaptureActive } from "../../hooks/hotkey-capture.hooks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("../../actions/hotkey.actions", () => ({
  savePrimaryHotkey: mocks.save,
}));
vi.mock("../../utils/analytics.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/analytics.utils")>()),
  trackButtonClick: vi.fn(),
}));
vi.mock("../common/KeyPressSimulator", () => ({
  KeyPressSimulator: ({ keys }: { keys: string[] }) => (
    <span>{keys.join("+")}</span>
  ),
}));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { KeybindingsForm } from "./KeybindingsForm";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
const setHeld = (keys: string[]) =>
  act(() =>
    produceAppState((draft) => {
      draft.keysHeld = keys;
    }),
  );
const render = async () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <KeybindingsForm />
      </MemoryRouter>,
    ),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  unmounted = false;
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
});

it("records growing unique held keys and stops on release", async () => {
  await render();
  act(() => button("Change hotkey").click());
  expect(isHotkeyCaptureActive(getAppState())).toBe(true);
  setHeld(["Control"]);
  setHeld(["Control", "Q", "Q"]);
  expect(mocks.save).toHaveBeenLastCalledWith(expect.any(String), [
    "Control",
    "Q",
  ]);
  setHeld(["Control"]);
  expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  expect(button("Change hotkey").disabled).toBe(false);
});

it("cancels on Escape without saving a shortcut", async () => {
  await render();
  act(() => button("Change hotkey").click());
  setHeld(["Escape"]);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(isHotkeyCaptureActive(getAppState())).toBe(false);
});

it("releases global hotkey capture when unmounted while listening", async () => {
  await render();
  act(() => button("Change hotkey").click());
  expect(isHotkeyCaptureActive(getAppState())).toBe(true);
  act(() => {
    root.unmount();
    unmounted = true;
  });
  expect(isHotkeyCaptureActive(getAppState())).toBe(false);
});

it("does not focus the capture box after Escape cancelled the pending focus", async () => {
  vi.useFakeTimers();
  try {
    await render();
    act(() => button("Change hotkey").click());
    setHeld(["Escape"]);
    act(() => vi.runOnlyPendingTimers());
    expect(container.contains(document.activeElement)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
