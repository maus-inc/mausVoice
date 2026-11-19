// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../actions/user.actions", () => ({
  setPreferredMicrophone: mocks.save,
}));
vi.mock("../../hooks/user.hooks", () => ({
  useMyPreferredMicrophone: () => null,
}));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: ({
    onChange,
    disabled,
  }: {
    onChange: (value: string) => void;
    disabled: boolean;
  }) =>
    createElement(
      "button",
      { onClick: () => onChange("External microphone"), disabled },
      "Select microphone",
    ),
}));
vi.mock("../microphone/MicrophoneTester", () => ({
  MicrophoneTester: ({ disabled }: { disabled?: boolean }) =>
    createElement("button", { disabled }, "Finish test"),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { MicrophoneDialog } from "./MicrophoneDialog";

ensureUiHarness();
it("locks a pending preference write against duplicate saves and dismissal, then permits retry", async () => {
  let reject!: (error: Error) => void;
  mocks.save.mockReset().mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  mocks.save.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.microphoneDialogOpen = true;
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (text: string) =>
    requireElement(
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === text,
      ),
      text,
    );
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(MicrophoneDialog),
        ),
      ),
    );
    act(() => button("Select microphone").click());
    act(() => {
      button("Save changes").click();
      button("Save changes").click();
      button("Close").click();
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.microphoneDialogOpen).toBe(true);
    expect(button("Close").hasAttribute("disabled")).toBe(true);
    expect(button("Finish test").hasAttribute("disabled")).toBe(false);
    expect(button("Save changes").getAttribute("aria-busy")).toBe("true");
    expect(
      button("Save changes").querySelector('[role="progressbar"]'),
    ).not.toBeNull();
    const content = requireElement(
      document.querySelector<HTMLElement>(".MuiDialogContent-root"),
      "dialog content",
    );
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, height: bottom - top }) as DOMRect;
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(100, 200));
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "alert"
          ? rect(230, 270)
          : rect(0, 0);
      });
    await act(async () => {
      reject(new Error("failed"));
    });
    expect(content.scrollTop).toBe(78);
    bounds.mockRestore();
    expect(document.body.textContent).toContain(
      "Failed to save microphone preference",
    );
    let resolve!: () => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    act(() => button("Save changes").click());
    act(() => button("Finish test").focus());
    content.scrollTop = 10;
    const movedBounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "alert"
          ? rect(230, 270)
          : rect(0, 0);
      });
    await act(async () => {
      resolve();
    });
    expect(content.scrollTop).toBe(10);
    expect(document.activeElement).toBe(button("Finish test"));
    movedBounds.mockRestore();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Preference saved.");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
