import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateAppMock, produceAppStateMock, surfaceMock, warningMock } =
  vi.hoisted(() => ({
    navigateAppMock: vi.fn(),
    produceAppStateMock: vi.fn(),
    surfaceMock: vi.fn(),
    warningMock: vi.fn(),
  }));

vi.mock("../utils/app-navigation", () => ({ navigateApp: navigateAppMock }));
vi.mock("../utils/window.utils", () => ({
  surfaceMainWindowDetached: surfaceMock,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: warningMock }),
}));
vi.mock("../store", () => ({ produceAppState: produceAppStateMock }));

import {
  openAssistantModeDialog,
  openAssistantModeSettings,
  withAssistantMode,
} from "./assistant-mode.actions";
import { ASSISTANT_MODE_SETTINGS_PATH } from "../components/settings/settings-routes";

/**
 * The assistant entry points that can fire while the feature is off share one
 * answer. Issue #355 was the Help page taking the other one, so what these pin
 * is that the destination is the Assistant mode row and that it is the same
 * string every surface uses.
 */
describe("assistant mode entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateAppMock.mockResolvedValue(undefined);
  });

  it("names the Assistant mode row as one address", () => {
    expect(ASSISTANT_MODE_SETTINGS_PATH).toBe(
      "/dashboard/settings/ai-models#setting-assistant_mode",
    );
  });

  it("surfaces the main window and opens the row", () => {
    openAssistantModeSettings();

    expect(surfaceMock).toHaveBeenCalledOnce();
    expect(navigateAppMock).toHaveBeenCalledWith(ASSISTANT_MODE_SETTINGS_PATH);
  });

  it("logs a rejected navigation instead of dropping it", async () => {
    navigateAppMock.mockRejectedValue(new Error("router not mounted"));
    openAssistantModeSettings();

    await vi.waitFor(() =>
      expect(warningMock).toHaveBeenCalledWith(
        "Failed to open the assistant mode setting: router not mounted",
      ),
    );
  });

  it("runs the assistant action while the feature is on", () => {
    const onEnabled = vi.fn();
    withAssistantMode(true, onEnabled);

    expect(onEnabled).toHaveBeenCalledOnce();
    expect(navigateAppMock).not.toHaveBeenCalled();
  });

  it("opens the setting instead of the action while the feature is off", () => {
    const onEnabled = vi.fn();
    withAssistantMode(false, onEnabled);

    expect(onEnabled).not.toHaveBeenCalled();
    expect(navigateAppMock).toHaveBeenCalledWith(ASSISTANT_MODE_SETTINGS_PATH);
  });

  /*
   * The class level. Issue #355 was one surface spelling an assistant route
   * for itself, so the guard is that the row has one spelling and the dialog
   * flag has one writer. Both are text rather than rendered behaviour: the
   * defect is a second copy, and a mounted assertion cannot see a copy that
   * happens to agree today.
   */
  it("spells the assistant mode row and its dialog in one place each", () => {
    const hits: string[] = [];
    const walk = (directory: URL): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = new URL(
          `${entry.name}${entry.isDirectory() ? "/" : ""}`,
          directory,
        );
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          const source = readFileSync(path, "utf8");
          if (
            source.includes('settingAnchorId("assistant_mode")') ||
            source.includes(
              "/dashboard/settings/ai-models#setting-assistant_mode",
            ) ||
            /agentModeDialogOpen\s*=\s*true/.test(source)
          ) {
            const relative = path.pathname.split("/src/").at(-1);
            if (!relative) throw new Error(`Unexpected path ${path.pathname}`);
            hits.push(relative);
          }
        }
      }
    };
    walk(new URL("../", import.meta.url));

    expect(hits.sort()).toEqual([
      "actions/assistant-mode.actions.ts",
      "components/settings/settings-routes.ts",
    ]);
  });

  /*
   * The entry points themselves. Each one is a call site inside a component
   * that needs a working recorder, a store and a window to render, so what is
   * checked here is the wiring: the surface reaches for the shared answer
   * rather than opening the feature on its own. The rendered behaviour of the
   * Help action is covered in its own suite; a key press is not, because this
   * environment has no WebDriver (see the PR body).
   */
  it.each([
    [
      "the Open chat key",
      "components/root/DictationSideEffects.tsx",
      /withAssistantMode\(assistantModeEnabled,/,
      /onFire: \(\) => \{\s*void openPillConversation/,
    ],
    [
      "the disabled-assistant toast",
      "components/root/AppSideEffects.tsx",
      /openAssistantModeSettings\(\)/,
      /draft\.settings\.agentModeDialogOpen = true/,
    ],
  ])("routes %s through the guard", (_name, file, wanted, reverted) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

    expect(source).toMatch(wanted);
    expect(source).not.toMatch(reverted);
  });

  it("opens the in-window dialog through the same state the toast sets", () => {
    openAssistantModeDialog();

    const update = produceAppStateMock.mock.calls.at(0)?.at(0);
    if (typeof update !== "function") {
      throw new Error("The dialog opener did not call produceAppState");
    }
    const draft: { settings: { agentModeDialogOpen: boolean } } = {
      settings: { agentModeDialogOpen: false },
    };
    update(draft);
    expect(draft.settings.agentModeDialogOpen).toBe(true);
  });
});
