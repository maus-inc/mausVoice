// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setUserName: vi.fn(),
  setMyProfileImage: vi.fn(),
  useMyUser: vi.fn(),
  useMyProfileImage: vi.fn(),
}));

vi.mock("../../actions/user.actions", () => ({
  setUserName: (...args: unknown[]) => mocks.setUserName(...args),
  setMyProfileImage: (...args: unknown[]) => mocks.setMyProfileImage(...args),
}));

vi.mock("../../hooks/user.hooks", () => ({
  useMyUser: () => mocks.useMyUser(),
  useMyProfileImage: () => mocks.useMyProfileImage(),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { ProfileDialog } from "./ProfileDialog";

ensureUiHarness();

const USER = {
  id: "user-1",
  name: "Morgan Lee",
  email: "morgan@example.com",
};

/**
 * The profile dialog is the one place the name and the photo are edited, so
 * these cover the promises the dialog makes: it says what the file can be, it
 * answers a bad file without closing, and it commits on Enter because it is a
 * form.
 */
describe("ProfileDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(ProfileDialog),
        ),
      );
    });

  const dialog = () =>
    document.querySelector<HTMLElement>('[role="dialog"]') ?? null;

  const nameInput = () =>
    document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="text"]',
    );

  /**
   * Types into a field the way a person does. Setting `.value` directly leaves
   * React's value tracker thinking nothing changed, so the native setter is the
   * only way the change reaches state.
   */
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  const pick = async (file: File) => {
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="file"]',
    );
    if (!input) {
      throw new Error("no file input");
    }
    // `setInputFiles` is Playwright's API; jsdom needs the change event by hand.
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    mocks.setUserName.mockReset();
    mocks.setUserName.mockResolvedValue(undefined);
    mocks.setMyProfileImage.mockReset();
    mocks.useMyUser.mockReset();
    mocks.useMyUser.mockReturnValue(USER);
    mocks.useMyProfileImage.mockReset();
    mocks.useMyProfileImage.mockReturnValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const open = () => {
    produceAppState((draft) => {
      draft.settings.profileDialogOpen = true;
    });
    render();
  };

  it("says what the picture may be, and starts from the saved name", () => {
    open();

    expect(dialog()?.textContent).toContain(
      "PNG, JPG, or WebP, up to 5 MB. Cropped to a square.",
    );
    expect(nameInput()?.value).toBe("Morgan Lee");
  });

  it("names the problem with a file it cannot use, and keeps the dialog open", async () => {
    open();

    await pick(new File(["notes"], "notes.txt", { type: "text/plain" }));

    expect(dialog()?.textContent).toContain(
      "Choose a PNG, JPG, or WebP image.",
    );
    expect(dialog()).not.toBeNull();
  });

  it("commits on Enter, because the body is a form", async () => {
    open();

    await type(nameInput()!, "Morgan Lee Jr.");
    const form = dialog()?.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.setUserName).toHaveBeenCalledWith("Morgan Lee Jr.");
  });

  it("saves nothing on Cancel", async () => {
    open();

    await type(nameInput()!, "Someone Else");
    const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    await act(async () => {
      cancel?.click();
    });

    expect(mocks.setUserName).not.toHaveBeenCalled();
    // Asserted on the store rather than on the DOM: MUI keeps the dialog node
    // mounted through its exit transition, which never finishes in jsdom.
    expect(getAppState().settings.profileDialogOpen).toBe(false);
  });
});
