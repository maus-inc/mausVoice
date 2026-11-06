// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../actions/updater.actions", () => ({
  dismissUpdateDialog: vi.fn(),
  installAvailableUpdate: vi.fn(),
}));
vi.mock("./ChangelogDialog", () => ({
  ChangelogDialog: ({ open }: { open: boolean }) =>
    open
      ? createElement("div", { "data-history": true }, "Release history")
      : null,
}));
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  dismissUpdateDialog,
  installAvailableUpdate,
} from "../../actions/updater.actions";
import type { UpdaterState } from "../../state/updater.state";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { UpdateDialog } from "./UpdateDialog";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
describe("update release-history entry point", () => {
  it.each([null, "", "Release notes"])(
    "opens history when notes are %s",
    async (releaseNotes) => {
      const state = structuredClone(INITIAL_APP_STATE);
      state.updater = {
        ...state.updater,
        dialogOpen: true,
        status: "ready",
        releaseNotes,
      };
      setAppState(state, true);
      await act(async () => root.render(createElement(UpdateDialog)));
      const history = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "View past releases",
      );
      if (!history) {
        throw new Error('Expected a "View past releases" button to render');
      }
      await act(async () => history.click());
      expect(document.querySelector("[data-history]")).not.toBeNull();
    },
  );
});

describe("update dialog states", () => {
  const renderUpdate = async (changes: Partial<UpdaterState>) => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.updater = {
      ...state.updater,
      dialogOpen: true,
      status: "ready",
      ...changes,
    };
    setAppState(state, true);
    await act(async () => root.render(createElement(UpdateDialog)));
  };
  const button = (label: string) => {
    const found = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };

  it("shows release information and starts or dismisses a ready update", async () => {
    await renderUpdate({
      availableVersion: "0.2.0",
      currentVersion: "0.1.0",
      offeredChannel: "beta",
      releaseNotes: "Important release notes",
    });
    expect(document.body.textContent).toContain("Beta");
    expect(document.body.textContent).toContain("Important release notes");
    await act(async () => button("Update").click());
    expect(installAvailableUpdate).toHaveBeenCalledOnce();
    await act(async () => button("Later").click());
    expect(dismissUpdateDialog).toHaveBeenCalledOnce();
  });

  it("disables both actions and shows clamped progress while downloading", async () => {
    await renderUpdate({
      status: "downloading",
      downloadProgress: 1.5,
      downloadedBytes: 5,
      totalBytes: 10,
    });
    expect(document.body.textContent).toContain("Downloading update...");
    expect(document.body.textContent).toContain("(100%)");
    expect(button("Update").disabled).toBe(true);
    expect(button("Later").disabled).toBe(true);
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("100");
  });

  it("offers the manual installer for read-only errors", async () => {
    await renderUpdate({
      status: "error",
      errorMessage: "read-only file system",
      manualInstallerUrl: "https://example.com/installer",
    });
    expect(document.body.textContent).toContain("read-only file system");
    await act(async () => button("Download installer").click());
    expect(openUrl).toHaveBeenCalledWith("https://example.com/installer");
  });

  it("allows closing when the separate installer is open", async () => {
    await renderUpdate({ status: "installing", requiresManualInstall: true });
    expect(document.body.textContent).toContain(
      "The installer has been opened.",
    );
    expect(button("Close").disabled).toBe(false);
    await act(async () => button("Close").click());
    expect(dismissUpdateDialog).toHaveBeenCalledOnce();
  });
});
