// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY } from "../../utils/local-data-write-gate";

const { deleteMyAccountMock, signOutMock, invokeMock, showSnackbarMock } =
  vi.hoisted(() => ({
    deleteMyAccountMock: vi.fn<() => Promise<void>>(),
    signOutMock: vi.fn<() => Promise<void>>(),
    invokeMock: vi.fn(),
    showSnackbarMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../repos", () => ({
  getAuthRepo: () => ({
    deleteMyAccount: deleteMyAccountMock,
    signOut: signOutMock,
  }),
}));
vi.mock("../../actions/app.actions", () => ({
  showSnackbar: showSnackbarMock,
}));
vi.mock("../../actions/edit-watch.actions", () => ({
  resetAutoLearnSessionState: vi.fn(),
}));
vi.mock("../../utils/pending-transcription-delete", () => ({
  resetPendingTranscriptionDeletes: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { IntlProvider } from "react-intl";
import en from "../../i18n/locales/en.json";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import {
  beginLocalDataClear,
  beginLocalDataWrite,
} from "../../utils/local-data-write-gate";

ensureUiHarness();

const TEST_EMAIL = "person@example.com";

describe("DeleteAccountDialog local-clear recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(DeleteAccountDialog),
        ),
      );
    });

  const submitWithConfirmedEmail = async () => {
    const input = document.body.querySelector<HTMLInputElement>("input");
    const button = Array.from(document.body.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Delete account"),
    );
    expect(input).not.toBeNull();
    expect(button).not.toBeUndefined();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, TEST_EMAIL);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.localStorage.clear();
    vi.clearAllMocks();
    deleteMyAccountMock.mockRejectedValue(new Error("delete failed"));
    signOutMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(undefined);

    const state = structuredClone(INITIAL_APP_STATE);
    state.auth = {
      uid: "local-user",
      email: TEST_EMAIL,
      displayName: "Local user",
      providers: ["personal"],
    };
    state.settings.deleteAccountDialog = true;
    setAppState(state, true);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    // A test may have exercised an interrupted clear and released its browser
    // marker intentionally. Drain the gate's in-memory clear owner as well.
    const releaseClear = await beginLocalDataClear();
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    releaseClear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.restoreAllMocks();
  });

  it("preserves a recovery marker that predates a failed account deletion", async () => {
    window.localStorage.setItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "1");
    render();

    await submitWithConfirmedEmail();

    expect(deleteMyAccountMock).toHaveBeenCalledOnce();
    expect(
      window.localStorage.getItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY),
    ).toBe("1");
    expect(beginLocalDataWrite()).toBeNull();
    expect(showSnackbarMock).toHaveBeenCalledOnce();
  });

  it("removes the marker created by an account-deletion attempt that fails", async () => {
    render();

    await submitWithConfirmedEmail();

    expect(deleteMyAccountMock).toHaveBeenCalledOnce();
    expect(
      window.localStorage.getItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY),
    ).toBeNull();
    const releaseWrite = beginLocalDataWrite();
    expect(releaseWrite).not.toBeNull();
    releaseWrite?.();
  });
});
