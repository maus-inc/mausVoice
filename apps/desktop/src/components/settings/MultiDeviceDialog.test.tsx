// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { ThemeProvider } from "@mui/material";
import { theme } from "../../theme";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { MultiDeviceDialog } from "./MultiDeviceDialog";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
vi.mock("../../actions/remote-receiver.actions", () => ({
  refreshRemoteReceiverStatus: vi.fn().mockResolvedValue(undefined),
  startRemoteReceiver: vi.fn(),
  stopRemoteReceiver: vi.fn(),
}));
ensureUiHarness();

it("names switches, bounds its width and preserves composing device names", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.multiDeviceDialogOpen = true;
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <ThemeProvider theme={theme}>
            <MultiDeviceDialog />
          </ThemeProvider>
        </IntlProvider>,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const content = dialog.querySelector<HTMLElement>(
      ".MuiDialogContent-root",
    )!;
    expect(getComputedStyle(content).minWidth).toBe("min(360px, 100%)");
    expect(
      [...dialog.querySelectorAll('[role="switch"]')].map((e) =>
        e.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Receive transcript from another device",
      "Start receiver automatically",
      "Send transcript to another device",
    ]);
    const add = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Add device",
    )!;
    act(() => add.click());
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    const pair = dialogs[dialogs.length - 1];
    const save = [...pair.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save",
    )!;
    await act(async () => save.click());
    expect(pair.querySelector('[role="alert"]')?.textContent).toBe(
      "Name, device ID, receiver address, and shared secret are required.",
    );
    const field = pair.querySelector<HTMLInputElement>("input")!;
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
      which: 27,
    });
    act(() => field.dispatchEvent(event));
    expect(pair.isConnected).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});
