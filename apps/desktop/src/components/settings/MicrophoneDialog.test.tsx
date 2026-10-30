// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const {
  getUserPreferences,
  setUserPreferences,
  showErrorSnackbar,
  loggerMock,
} = vi.hoisted(() => ({
  getUserPreferences: vi.fn(() => Promise.resolve(null)),
  setUserPreferences: vi.fn((preferences: unknown) =>
    Promise.resolve(preferences),
  ),
  showErrorSnackbar: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar }));
vi.mock("../../repos", () => ({
  getUserPreferencesRepo: () => ({ getUserPreferences, setUserPreferences }),
  getUserRepo: () => ({ getMyUser: vi.fn(), setMyUser: vi.fn() }),
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: ({
    onChange,
  }: {
    onChange: (value: string | null) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "select-test-microphone",
        onClick: () => onChange("test-device"),
      },
      "Select test microphone",
    ),
}));
vi.mock("../microphone/MicrophoneTester", () => ({
  MicrophoneTester: () => createElement("div", { "data-testid": "tester" }),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { setSnackbar } from "../../utils/app.utils";
import en from "../../i18n/locales/en.json";
import { SnackbarEmitter } from "../root/SnackbarEmitter";
import { resetSnackbarEmitForTests } from "../root/snackbar-emit";
import { MicrophoneDialog } from "./MicrophoneDialog";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

describe("MicrophoneDialog save feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  const openDialog = () => {
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = true;
    });
  };

  const renderDialog = async () => {
    await act(async () => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            ThemeProvider,
            { theme },
            createElement(
              "div",
              null,
              createElement(MicrophoneDialog),
              createElement(SnackbarEmitter),
            ),
          ),
        ),
      );
    });
  };

  const clickButton = async (selector: string) => {
    const button = document.body.querySelector<HTMLButtonElement>(selector);
    if (!button) {
      throw new Error(`Missing button: ${selector}`);
    }
    await act(async () => {
      button.click();
    });
  };

  const clickSave = async () => {
    const button = Array.from(document.body.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Save changes"),
    );
    if (!button) {
      throw new Error("Missing save button");
    }
    await act(async () => {
      button.click();
    });
  };

  beforeEach(() => {
    resetState();
    resetSnackbarEmitForTests();
    toast.dismiss();
    getUserPreferences.mockReset().mockResolvedValue(null);
    setUserPreferences
      .mockReset()
      .mockImplementation((preferences) => Promise.resolve(preferences));
    showErrorSnackbar.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    toast.dismiss();
    resetSnackbarEmitForTests();
    resetState();
  });

  it("announces persisted success in the dialog and shows the global toast", async () => {
    let resolveSave: (() => void) | undefined;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    setUserPreferences.mockImplementation((preferences) =>
      save.then(() => preferences),
    );

    openDialog();
    await renderDialog();
    await clickButton('[data-testid="select-test-microphone"]');
    await clickSave();

    expect(setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ preferredMicrophone: "test-device" }),
    );
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();

    await act(async () => {
      // A concurrent state-backed notification must not replace the save
      // confirmation before the SnackbarEmitter's effect runs.
      produceAppState((draft) => {
        setSnackbar(draft, "Concurrent notification", { mode: "info" });
      });
      resolveSave?.();
      await save;
      await expect
        .poll(() => {
          const toastText = Array.from(
            document.body.querySelectorAll("[data-sonner-toast]"),
          ).map((toastNode) => toastNode.textContent ?? "");
          return (
            toastText.some((text) => text.includes("Preference saved.")) &&
            toastText.some((text) => text.includes("Concurrent notification"))
          );
        })
        .toBe(true);
    });

    const dialog = document.body.querySelector<HTMLElement>("[role='dialog']");
    const successToast = document.body.querySelector(
      '[data-sonner-toast][data-type="success"]',
    );
    const announcement = dialog?.querySelector<HTMLElement>("[role='status']");
    const toaster = document.body.querySelector("[data-sonner-toaster]");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[role="alert"]')).toBeNull();
    expect(announcement?.getAttribute("aria-live")).toBe("polite");
    expect(announcement?.getAttribute("aria-atomic")).toBe("true");
    expect(announcement?.textContent).toBe("Preference saved.");
    expect(announcement?.style.position).toBe("absolute");
    expect(successToast).not.toBeNull();
    expect(successToast!.textContent).toContain("Preference saved.");
    expect(dialog!.contains(successToast)).toBe(false);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(container.contains(toaster)).toBe(true);
    expect(showErrorSnackbar).not.toHaveBeenCalled();
  });

  it("keeps save failures inline without dismissing during save or a global error toast", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const save = new Promise<unknown>((_resolve, reject) => {
      rejectSave = reject;
    });
    setUserPreferences.mockImplementation(() => save);

    openDialog();
    await renderDialog();
    await clickButton('[data-testid="select-test-microphone"]');
    await clickSave();

    const dialogWhileSaving =
      document.body.querySelector<HTMLElement>('[role="dialog"]');
    const closeButton = Array.from(
      dialogWhileSaving?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent?.includes("Close"));
    const modalRoot =
      document.body.querySelector<HTMLElement>(".MuiModal-root");
    const backdrop =
      document.body.querySelector<HTMLElement>(".MuiBackdrop-root");
    expect(closeButton?.disabled).toBe(true);
    expect(modalRoot).not.toBeNull();
    expect(backdrop).not.toBeNull();

    await act(async () => {
      modalRoot?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      backdrop?.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      rejectSave?.(new Error("storage unavailable"));
      await save.catch(() => undefined);
    });
    await expect
      .poll(() =>
        document.body
          .querySelector('[role="dialog"]')
          ?.textContent?.includes(
            "Failed to save microphone preference. Please try again.",
          ),
      )
      .toBe(true);

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "Failed to save microphone preference. Please try again.",
    );
    expect(dialog?.querySelector('[role="status"]')?.textContent).toBe("");
    expect(
      Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
        button.textContent?.includes("Close"),
      )?.disabled,
    ).toBe(false);
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });
});
