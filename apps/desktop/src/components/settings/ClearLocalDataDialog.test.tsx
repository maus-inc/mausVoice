// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import {
  ACCOUNT_CREATED_AT_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  ONBOARDED_AT_STORAGE_KEY,
} from "../../utils/local-storage.utils";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { ClearLocalDataDialog } from "./ClearLocalDataDialog";

ensureUiHarness();

// `setAppState(..., true)` wants a whole AppState; the store's draft helper is
// how the app itself opens a dialog, so the test opens it the same way.
const openDialog = () => {
  produceAppState((draft) => {
    draft.settings.clearLocalDataDialogOpen = true;
  });
};

describe("ClearLocalDataDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () => {
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(ClearLocalDataDialog),
        ),
      );
    });
  };

  /**
   * The phrase gate lives on the typed value, so the confirm button has to stay
   * disabled until the field matches. Reaching the input through the label is
   * the same path a person takes.
   */
  const typeConfirmation = (value: string) => {
    // MUI dialogs render through a portal on the document body, not in the
    // container the root was attached to.
    const input = document.querySelector<HTMLInputElement>("input");
    if (!input) {
      throw new Error("No confirmation input rendered");
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  const confirmButton = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Clear local data",
    );

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    // jsdom cannot navigate, so the reload the dialog performs after a wipe is
    // observed instead of executed.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("asks for the phrase, so a stray click cannot wipe the device", () => {
    openDialog();
    render();

    expect(confirmButton()?.hasAttribute("disabled")).toBe(true);

    typeConfirmation("clear");

    expect(confirmButton()?.hasAttribute("disabled")).toBe(false);
  });

  it("empties localStorage after the Rust wipe and before the reload", async () => {
    window.localStorage.setItem(
      LOCAL_STATE_STORAGE_KEY,
      JSON.stringify({ state: { local: {} } }),
    );
    window.localStorage.setItem(ACCOUNT_CREATED_AT_STORAGE_KEY, "2026-01-01");
    window.localStorage.setItem(ONBOARDED_AT_STORAGE_KEY, "2026-01-02");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    openDialog();
    render();
    typeConfirmation("clear");
    act(() => {
      confirmButton()?.click();
    });

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("clear_local_data");
    });

    expect(window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(ACCOUNT_CREATED_AT_STORAGE_KEY),
    ).toBeNull();
    expect(window.localStorage.getItem(ONBOARDED_AT_STORAGE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalled();
  });

  it("stops the recorder and the key listener before wiping", async () => {
    openDialog();
    render();
    typeConfirmation("clear");
    act(() => {
      confirmButton()?.click();
    });

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("clear_local_data");
    });

    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands.indexOf("stop_key_listener")).toBeLessThan(
      commands.indexOf("clear_local_data"),
    );
    expect(commands.indexOf("stop_recording")).toBeLessThan(
      commands.indexOf("clear_local_data"),
    );
  });

  it("keeps the dialog open and reports the failure when the wipe fails", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "clear_local_data"
        ? Promise.reject(new Error("database is locked"))
        : Promise.resolve(undefined),
    );

    openDialog();
    render();
    typeConfirmation("clear");
    act(() => {
      confirmButton()?.click();
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("database is locked");
    });
    // Still mounted: the failure keeps the dialog and its confirmation field on
    // screen so the person can retry.
    expect(document.querySelector("input")).not.toBeNull();
  });
});
