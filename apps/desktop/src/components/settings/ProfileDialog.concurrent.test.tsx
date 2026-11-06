// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setUserName: vi.fn(),
  setMyProfileImage: vi.fn(),
}));
vi.mock("../../actions/user.actions", () => mocks);
vi.mock("../../hooks/user.hooks", () => ({
  useMyUser: () => ({ id: "user-1", name: "Morgan Lee" }),
  useMyProfileImage: () => null,
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
import { produceAppState, setAppState } from "../../store";
import { ProfileDialog } from "./ProfileDialog";

ensureUiHarness();

it("ignores duplicate submissions before pending state renders and allows retry", async () => {
  let reject!: (error: Error) => void;
  mocks.setUserName.mockReset();
  mocks.setUserName.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  mocks.setUserName.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.profileDialogOpen = true;
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(ProfileDialog),
        ),
      ),
    );
    const input = requireElement(
      document.querySelector<HTMLInputElement>(
        '[role="dialog"] input[type="text"]',
      ),
      "name",
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, "Draft name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = requireElement(
      document.querySelector('[role="dialog"] form'),
      "form",
    );
    const submit = () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    act(() => {
      submit();
      submit();
    });
    expect(mocks.setUserName).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("failed"));
    });
    await act(async () => {
      submit();
    });
    expect(mocks.setUserName).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
