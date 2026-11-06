import type { AppTarget, UserPreferences } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  setAppTargetPasteKeybind,
  setAppTargetTone,
  tryRegisterCurrentAppTarget,
} from "./app-target.actions";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  upload: vi.fn<() => Promise<void>>(),
  upsert: vi.fn<(params: AppTarget) => Promise<AppTarget>>(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../repos", () => ({
  getAppTargetRepo: () => ({ upsertAppTarget: mocks.upsert }),
  getStorageRepo: () => ({ uploadData: mocks.upload }),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    stopwatch: async (_name: string, action: () => Promise<unknown>) =>
      action(),
  }),
}));

const target: AppTarget = {
  id: "text_editor",
  name: "Old name",
  createdAt: "2026-01-01T00:00:00.000Z",
  toneId: "email",
  iconPath: null,
  pasteKeybind: "Alt+V",
  insertionMethod: "type",
  typingSpeedMs: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command) =>
    command === "get_current_app_info"
      ? { appName: "  Text Editor  ", iconBase64: "AQID" }
      : undefined,
  );
  mocks.upload.mockResolvedValue();
  mocks.upsert.mockImplementation(async (params) => ({
    ...params,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = { pasteKeybind: "Ctrl+V" } as UserPreferences;
  setAppState(state, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("current app registration", () => {
  it("uploads a decoded icon, applies defaults, and returns the registered target", async () => {
    const result = await tryRegisterCurrentAppTarget();
    expect(mocks.invoke).toHaveBeenCalledWith("set_register_app_label", {
      appName: "Text Editor",
    });
    expect(mocks.upload).toHaveBeenCalledWith({
      path: "unknown-user/app-icons/text_editor.png",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      id: "text_editor",
      name: "Text Editor",
      toneId: null,
      iconPath: "unknown-user/app-icons/text_editor.png",
      pasteKeybind: "Ctrl+V",
      insertionMethod: null,
      typingSpeedMs: null,
    });
    expect(result).toEqual(getAppState().appTargetById.text_editor);
  });

  it("preserves existing settings when an icon is added, including a zero typing speed", async () => {
    setAppState(
      { ...getAppState(), appTargetById: { text_editor: target } },
      true,
    );
    await tryRegisterCurrentAppTarget();
    expect(mocks.upsert).toHaveBeenCalledWith({
      id: "text_editor",
      name: "Text Editor",
      toneId: "email",
      iconPath: "unknown-user/app-icons/text_editor.png",
      pasteKeybind: "Alt+V",
      insertionMethod: "type",
      typingSpeedMs: 0,
    });
  });

  it("does not upload or upsert an app that already has an icon", async () => {
    const existing = { ...target, iconPath: "existing.png" };
    setAppState(
      { ...getAppState(), appTargetById: { text_editor: existing } },
      true,
    );
    expect(await tryRegisterCurrentAppTarget()).toEqual(existing);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("continues registration when icon upload and cosmetic tray update fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upload.mockRejectedValueOnce(new Error("disk"));
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "set_register_app_label") throw new Error("tray");
      return { appName: "Text Editor", iconBase64: "AQID" };
    });
    const result = await tryRegisterCurrentAppTarget();
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ iconPath: null, pasteKeybind: "Ctrl+V" }),
    );
    expect(result?.id).toBe("text_editor");
  });

  it("keeps the existing target if persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setAppState(
      { ...getAppState(), appTargetById: { text_editor: target } },
      true,
    );
    mocks.upsert.mockRejectedValueOnce(new Error("storage"));
    expect(await tryRegisterCurrentAppTarget()).toEqual(target);
  });
});

it("does not register an app after its lookup is retired", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let current = true;
  const registration = tryRegisterCurrentAppTarget(() => current);
  current = false;
  finish({ appName: "Editor", iconBase64: "AQID" });
  await expect(registration).resolves.toBeNull();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("does not register an app after its icon upload completes late", async () => {
  let finish!: () => void;
  mocks.upload.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let current = true;
  const registration = tryRegisterCurrentAppTarget(() => current);
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalled());
  current = false;
  finish();
  await expect(registration).resolves.toBeNull();
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it("serializes per-app settings writes so different fields cannot overwrite each other", async () => {
  setAppState(
    { ...getAppState(), appTargetById: { text_editor: target } },
    true,
  );
  let finish!: () => void;
  mocks.upsert.mockImplementationOnce(
    (params) =>
      new Promise((resolve) => {
        finish = () => resolve({ ...params, createdAt: target.createdAt });
      }),
  );
  const tone = setAppTargetTone(target.id, "new-tone");
  const keybind = setAppTargetPasteKeybind(target.id, "Ctrl+Shift+V");
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([tone, keybind]);
  expect(mocks.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({
      toneId: "new-tone",
      pasteKeybind: "Ctrl+Shift+V",
    }),
  );
  expect(getAppState().appTargetById.text_editor).toMatchObject({
    toneId: "new-tone",
    pasteKeybind: "Ctrl+Shift+V",
  });
});

it("does not overwrite a settings change that finishes while a missing icon uploads", async () => {
  setAppState(
    { ...getAppState(), appTargetById: { text_editor: target } },
    true,
  );
  let finishUpload!: () => void;
  mocks.upload.mockReturnValueOnce(
    new Promise((resolve) => {
      finishUpload = resolve;
    }),
  );
  const registration = tryRegisterCurrentAppTarget();
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalled());
  await setAppTargetTone(target.id, "new-tone");
  finishUpload();
  await registration;
  expect(mocks.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({
      toneId: "new-tone",
      iconPath: "unknown-user/app-icons/text_editor.png",
    }),
  );
  expect(getAppState().appTargetById.text_editor.toneId).toBe("new-tone");
});

it("allows different targets to save concurrently", async () => {
  const other = { ...target, id: "browser", name: "Browser" };
  setAppState(
    {
      ...getAppState(),
      appTargetById: { text_editor: target, browser: other },
    },
    true,
  );
  let finish!: () => void;
  mocks.upsert.mockImplementationOnce(
    (params) =>
      new Promise((resolve) => {
        finish = () => resolve({ ...params, createdAt: target.createdAt });
      }),
  );
  const first = setAppTargetTone(target.id, "new-tone");
  const second = setAppTargetPasteKeybind(other.id, "Ctrl+V");
  expect(mocks.upsert).toHaveBeenCalledTimes(2);
  await second;
  finish();
  await first;
  expect(getAppState().appTargetById.browser.pasteKeybind).toBe("Ctrl+V");
});

it("releases the target queue after a failed write and preserves the old fields", async () => {
  setAppState(
    { ...getAppState(), appTargetById: { text_editor: target } },
    true,
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail!: (error: Error) => void;
  mocks.upsert.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const first = setAppTargetTone(target.id, "new-tone");
  const second = setAppTargetPasteKeybind(target.id, "Ctrl+V");
  fail(new Error("unavailable"));
  expect(await first).toBe(false);
  await second;
  expect(mocks.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({ toneId: "email", pasteKeybind: "Ctrl+V" }),
  );
  expect(getAppState().appTargetById.text_editor).toMatchObject({
    toneId: "email",
    pasteKeybind: "Ctrl+V",
  });
});
