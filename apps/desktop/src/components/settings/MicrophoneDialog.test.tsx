// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { setPreferredMicrophone } = vi.hoisted(() => ({
  setPreferredMicrophone: vi.fn(),
}));

vi.mock("../../actions/user.actions", () => ({ setPreferredMicrophone }));
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
import en from "../../i18n/locales/en.json";
import { SnackbarEmitter } from "../root/SnackbarEmitter";
import { resetSnackbarEmitForTests } from "../root/snackbar-emit";
import { MicrophoneDialog } from "./MicrophoneDialog";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const openDialog = () => {
  produceAppState((draft) => {
    draft.settings.microphoneDialogOpen = true;
  });
};

describe("MicrophoneDialog save feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

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
    setPreferredMicrophone.mockReset();
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

  it("shows a success toast only after the preference save resolves", async () => {
    let resolveSave: (() => void) | undefined;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    setPreferredMicrophone.mockReturnValue(save);

    openDialog();
    await renderDialog();
    await clickButton('[data-testid="select-test-microphone"]');
    await clickSave();

    expect(setPreferredMicrophone).toHaveBeenCalledWith("test-device");
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();

    await act(async () => {
      resolveSave?.();
      await save;
    });

    await act(async () => {
      await expect
        .poll(() =>
          document.body.querySelector(
            '[data-sonner-toast][data-type="success"]',
          ),
        )
        .not.toBeNull();
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    const successToast = document.body.querySelector(
      '[data-sonner-toast][data-type="success"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).not.toContain("Preference saved.");
    expect(successToast).not.toBeNull();
    expect(successToast!.textContent).toContain("Preference saved.");
    expect(dialog!.contains(successToast)).toBe(false);
  });

  it("keeps save failures inline and does not show a success toast", async () => {
    setPreferredMicrophone.mockRejectedValue(new Error("storage unavailable"));

    openDialog();
    await renderDialog();
    await clickButton('[data-testid="select-test-microphone"]');
    await clickSave();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "Failed to save microphone preference. Please try again.",
    );
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });
});
