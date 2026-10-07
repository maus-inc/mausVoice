// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setUserName: vi.fn(),
  setMyProfileImage: vi.fn(),
  useMyUser: vi.fn(),
  useMyProfileImage: vi.fn(),
  readAvatarFile: vi.fn(),
}));

vi.mock("../../actions/user.actions", () => ({
  setUserName: (...args: unknown[]) => mocks.setUserName(...args),
  setMyProfileImage: (...args: unknown[]) => mocks.setMyProfileImage(...args),
}));

vi.mock("../../hooks/user.hooks", () => ({
  useMyUser: () => mocks.useMyUser(),
  useMyProfileImage: () => mocks.useMyProfileImage(),
}));

// The decode needs a canvas, so the dialog test drives the wiring around it:
// what the component does with a decoded photo, and what it does with a refusal.
vi.mock("../../utils/avatar.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/avatar.utils")>()),
  readAvatarFile: (file: File) => mocks.readAvatarFile(file),
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
import { requireElement } from "../../../test/helpers/dom";
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
    act(() => {
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
      // The chosen file is decoded off-thread and the dialog commits in a
      // microtask after the change event, so the callback has to await a tick
      // for that commit to land before the assertions run.
      await Promise.resolve();
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
    mocks.readAvatarFile.mockReset();
    // Default to a refusal, so a test that does not care about the decode still
    // exercises the branch the dialog has to answer.
    mocks.readAvatarFile.mockResolvedValue({
      ok: false,
      error: "unsupported-type",
    });
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

    await type(requireElement(nameInput(), "the name field"), "Morgan Lee Jr.");
    const form = requireElement(dialog()?.querySelector("form"), "the form");
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.setUserName).toHaveBeenCalledWith("Morgan Lee Jr.");
  });

  it("previews the decoded photo and saves it with the name", async () => {
    mocks.readAvatarFile.mockResolvedValue({
      ok: true,
      dataUrl: "data:image/jpeg;base64,NEW",
    });
    open();

    await pick(new File(["x"], "photo.png", { type: "image/png" }));

    // The line under the circle reports what is about to be saved, and the
    // save arms only because the photo differs from the stored one.
    expect(dialog()?.textContent).toContain("New photo ready to save.");
    const save = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(save?.hasAttribute("disabled")).toBe(false);

    await type(requireElement(nameInput(), "the name field"), "Morgan Lee Jr.");
    // Awaited, so the save's own state updates land inside the act: the dialog
    // is mounted until its exit transition finishes.
    await act(async () => {
      requireElement(dialog()?.querySelector("form"), "the form").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(mocks.setMyProfileImage).toHaveBeenCalledWith(
        "data:image/jpeg;base64,NEW",
      );
    });
    expect(mocks.setUserName).toHaveBeenCalledWith("Morgan Lee Jr.");
  });

  it("saves only the photo when the name is unchanged", async () => {
    mocks.readAvatarFile.mockResolvedValue({
      ok: true,
      dataUrl: "data:image/jpeg;base64,NEW",
    });
    open();

    await pick(new File(["x"], "photo.png", { type: "image/png" }));
    // Awaited, so the save's own state updates land inside the act: the dialog
    // is mounted until its exit transition finishes.
    await act(async () => {
      requireElement(dialog()?.querySelector("form"), "the form").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(mocks.setMyProfileImage).toHaveBeenCalledWith(
        "data:image/jpeg;base64,NEW",
      );
    });
    expect(mocks.setUserName).not.toHaveBeenCalled();
  });

  it("arms removal when the photo is removed", async () => {
    mocks.useMyProfileImage.mockReturnValue("data:image/png;base64,OLD");
    open();

    const remove = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Remove photo",
    );
    act(() => {
      requireElement(remove, "the Remove photo button").click();
    });

    expect(dialog()?.textContent).toContain("Photo will be removed on save.");

    // Awaited, so the save's own state updates land inside the act: the dialog
    // is mounted until its exit transition finishes.
    await act(async () => {
      requireElement(dialog()?.querySelector("form"), "the form").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(mocks.setMyProfileImage).toHaveBeenCalledWith(null);
    });
  });

  it("saves nothing on Cancel", async () => {
    open();

    await type(requireElement(nameInput(), "the name field"), "Someone Else");
    const cancel = requireElement(
      [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Cancel",
      ),
      "the Cancel button",
    );
    act(() => {
      cancel.click();
    });

    expect(mocks.setUserName).not.toHaveBeenCalled();
    // Asserted on the store rather than on the DOM: MUI keeps the dialog node
    // mounted through its exit transition, which never finishes in jsdom.
    expect(getAppState().settings.profileDialogOpen).toBe(false);
  });
});
