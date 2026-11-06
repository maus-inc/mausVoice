import type { UserPreferences } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { tone } from "../../test/helpers/tone-test.utils";

const mocks = vi.hoisted(() => ({
  setPreferences: vi.fn(),
  getPreferences: vi.fn(),
  deleteTone: vi.fn(),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => ({
    setUserPreferences: mocks.setPreferences,
    getUserPreferences: mocks.getPreferences,
  }),
  getUserRepo: () => ({}),
  getToneRepo: () => ({ deleteTone: mocks.deleteTone }),
}));
vi.mock("./app.actions", () => ({
  showSnackbar: mocks.showSnackbar,
  showErrorSnackbar: mocks.showErrorSnackbar,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createDefaultPreferences,
  setPreserveAudioOnFailure,
} from "./user.actions";
import { deleteTone, setActiveTone } from "./tone.actions";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = createDefaultPreferences();
  state.toneById.email = tone("email", "Email");
  state.toneById.chat = tone("chat", "Chat");
  setAppState(state, true);
  mocks.setPreferences.mockImplementation(
    async (prefs: UserPreferences) => prefs,
  );
  mocks.getPreferences.mockResolvedValue(null);
  mocks.deleteTone.mockResolvedValue(undefined);
});

describe("tone preference ownership", () => {
  it("serializes a default-style change with other preference writes", async () => {
    const write = deferred<UserPreferences>();
    mocks.setPreferences.mockReturnValueOnce(write.promise);
    const first = setPreserveAudioOnFailure(false);
    await vi.waitFor(() => expect(mocks.setPreferences).toHaveBeenCalledOnce());
    const style = setActiveTone("email");
    expect(mocks.setPreferences).toHaveBeenCalledOnce();
    const firstPayload = mocks.setPreferences.mock
      .calls[0][0] as UserPreferences;
    write.resolve(firstPayload);
    await Promise.all([first, style]);
    expect(mocks.setPreferences).toHaveBeenCalledTimes(2);
    expect(mocks.setPreferences.mock.calls[1][0]).toMatchObject({
      preserveAudioOnFailure: false,
      activeToneId: "email",
    });
    expect(getAppState().userPrefs).toMatchObject({
      preserveAudioOnFailure: false,
      activeToneId: "email",
    });
  });

  it("clears a deleted active style after an older preference write finishes", async () => {
    const state = getAppState();
    setAppState(
      { ...state, userPrefs: { ...state.userPrefs!, activeToneId: "email" } },
      true,
    );
    const write = deferred<UserPreferences>();
    mocks.setPreferences.mockReturnValueOnce(write.promise);
    const first = setPreserveAudioOnFailure(false);
    await vi.waitFor(() => expect(mocks.setPreferences).toHaveBeenCalledOnce());
    const deleting = deleteTone("email");
    await vi.waitFor(() =>
      expect(getAppState().toneById.email).toBeUndefined(),
    );
    expect(getAppState().userPrefs?.activeToneId).toBeNull();
    write.resolve(mocks.setPreferences.mock.calls[0][0] as UserPreferences);
    await Promise.all([first, deleting]);
    expect(mocks.setPreferences.mock.calls[1][0]).toMatchObject({
      preserveAudioOnFailure: false,
      activeToneId: null,
    });
    expect(getAppState().userPrefs).toMatchObject({
      preserveAudioOnFailure: false,
      activeToneId: null,
    });
  });

  it("does not overwrite another selected style when deleting an inactive one", async () => {
    const state = getAppState();
    setAppState(
      { ...state, userPrefs: { ...state.userPrefs!, activeToneId: "chat" } },
      true,
    );
    await deleteTone("email");
    expect(mocks.setPreferences).not.toHaveBeenCalled();
    expect(getAppState().userPrefs?.activeToneId).toBe("chat");
  });

  it("does not select a style deleted while its preference write was queued", async () => {
    const write = deferred<UserPreferences>();
    mocks.setPreferences.mockReturnValueOnce(write.promise);
    const first = setPreserveAudioOnFailure(false);
    await vi.waitFor(() => expect(mocks.setPreferences).toHaveBeenCalledOnce());
    const selecting = setActiveTone("email");
    const rejected = expect(selecting).rejects.toThrow("Failed to save tone.");
    const deleting = deleteTone("email");
    await vi.waitFor(() =>
      expect(getAppState().toneById.email).toBeUndefined(),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    write.resolve(mocks.setPreferences.mock.calls[0][0] as UserPreferences);
    await Promise.all([first, rejected, deleting]);
    consoleError.mockRestore();
    expect(mocks.setPreferences).toHaveBeenCalledOnce();
    expect(getAppState().userPrefs?.activeToneId).toBeNull();
  });
});
