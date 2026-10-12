// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  deleteMyAccount: vi.fn(),
  signOut: vi.fn(),
  showSnackbar: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("../../repos", () => ({
  getAuthRepo: () => ({
    deleteMyAccount: () => mocks.deleteMyAccount(),
    signOut: () => mocks.signOut(),
  }),
}));

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: (...args: unknown[]) => mocks.showSnackbar(...args),
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
import { DeleteAccountDialog } from "./DeleteAccountDialog";

ensureUiHarness();

const EMAIL = "morgan@example.com";
const CONFIRMATION_PHRASE = "delete";
const DELETION_FAILED =
  "An error occurred while attempting to delete your account. Please try again later.";
const DELETED_BUT_LEFT_BEHIND =
  "Your data was deleted from this device, but some of it could not be removed. Quit and reopen mausVoice.";
const DELETED = "Your data has been deleted from this device";

const snackbarMessages = () =>
  mocks.showSnackbar.mock.calls.map(([message]) => String(message));

/**
 * Deleting the account is two promises: the profile goes, and this device stops
 * holding what it kept for it. The dialog is where they meet, so these cover the
 * seam and the reporting around it — a wipe that cannot finish must not be told
 * as a deletion that failed, and the profile photo must not outlive the profile
 * it belongs to. What the dialog must not do is promise effects this build
 * cannot deliver: the toast names what was deleted from this device, because
 * there is no server-side account left for it to have deleted.
 */
describe("DeleteAccountDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () => {
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(DeleteAccountDialog),
        ),
      );
    });
  };

  const typeConfirmation = (value: string) => {
    // The dialog renders through a portal, so its fields are on the document
    // rather than inside the test's own container.
    const input = requireElement(
      document.querySelector("input"),
      "the confirmation field",
    );
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
      (button) => button.textContent?.trim() === "Delete account",
    );

  const submit = async () => {
    typeConfirmation(CONFIRMATION_PHRASE);
    await act(async () => {
      confirmButton()?.click();
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    mocks.invoke.mockReset();
    // The explicit `undefined` is the argument these mocks' types ask for:
    // `mockResolvedValue()` does not compile against them ("Expected 1
    // arguments, but got 0"), so dropping it is a type error rather than a
    // tidy-up.
    mocks.invoke.mockResolvedValue(undefined);
    mocks.deleteMyAccount.mockReset();
    mocks.deleteMyAccount.mockResolvedValue(undefined);
    mocks.signOut.mockReset();
    mocks.signOut.mockResolvedValue(undefined);
    mocks.showSnackbar.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((draft) => {
      draft.settings.deleteAccountDialog = true;
      draft.auth = { uid: "user-1", email: EMAIL } as typeof draft.auth;
      draft.local.profileImageByUserId = {
        "user-1": "data:image/png;base64,AAAA",
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("removes this device's copy of the profile photo with the account", async () => {
    render();
    await submit();

    expect(mocks.deleteMyAccount).toHaveBeenCalled();
    expect(getAppState().local.profileImageByUserId).toEqual({});
    expect(
      window.localStorage.getItem("mausvoice-local-state") ?? "",
    ).not.toContain("data:image/png");
    expect(snackbarMessages()).toEqual([DELETED]);
    expect(getAppState().settings.deleteAccountDialog).toBe(false);
  });

  it("tells the deletion apart from a wipe that could not finish", async () => {
    mocks.invoke.mockImplementation((command: unknown) =>
      command === "clear_local_data"
        ? Promise.reject(new Error("database is locked"))
        : Promise.resolve(),
    );

    render();
    await submit();

    expect(mocks.deleteMyAccount).toHaveBeenCalled();
    expect(snackbarMessages()).toEqual([DELETED_BUT_LEFT_BEHIND]);
    expect(snackbarMessages()).not.toContain(DELETION_FAILED);
    // The account is gone even though the wipe is not finished, so the sign-out
    // still has to happen.
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it("says the deletion failed when the deletion is what failed", async () => {
    mocks.deleteMyAccount.mockRejectedValue(new Error("offline"));

    render();
    await submit();

    expect(snackbarMessages()).toEqual([DELETION_FAILED]);
    expect(getAppState().settings.deleteAccountDialog).toBe(true);
    expect(getAppState().local.profileImageByUserId).toEqual({
      "user-1": "data:image/png;base64,AAAA",
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
