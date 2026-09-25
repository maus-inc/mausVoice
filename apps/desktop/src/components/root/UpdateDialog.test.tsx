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
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { UpdateDialog } from "./UpdateDialog";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
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
      expect(history).toBeDefined();
      await act(async () => history!.click());
      expect(document.querySelector("[data-history]")).not.toBeNull();
    },
  );
});
