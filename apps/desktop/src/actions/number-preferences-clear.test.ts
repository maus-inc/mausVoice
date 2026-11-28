import type { User, UserPreferences } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import esMessages from "../i18n/locales/es.json";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { createDefaultPreferences } from "./user-actions-core";
import { refreshCurrentUser } from "./user-activity.actions";
import {
  setIncognitoModeEnabled,
  setUserName,
} from "./user-preferences.actions";
import {
  setDictationLimitMinutes,
  setHandsFreeDelayMs,
} from "./user-settings.actions";
import { setMyProfileImage } from "./user-style.actions";

const { userRepoMock, userPrefsRepoMock, storageRepoMock } = vi.hoisted(() => ({
  userRepoMock: {
    getMyUser: vi.fn<() => Promise<User | null>>(),
    setMyUser: vi.fn<(user: User) => Promise<User>>(),
  },
  userPrefsRepoMock: {
    getUserPreferences: vi.fn<() => Promise<UserPreferences | null>>(),
    setUserPreferences:
      vi.fn<(prefs: UserPreferences) => Promise<UserPreferences>>(),
  },
  storageRepoMock: {
    getString: vi.fn(),
    setString: vi.fn(),
  },
}));

vi.mock("../repos", () => ({
  getUserRepo: () => userRepoMock,
  getUserPreferencesRepo: () => userPrefsRepoMock,
  getStorageRepo: () => storageRepoMock,
}));

const seedUser = (): User => ({
  id: LOCAL_USER_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  name: "Initial",
  onboarded: true,
  playInteractionChime: true,
  hasFinishedTutorial: true,
  wordsThisMonth: 0,
  wordsTotal: 0,
});

describe("user and preference local-data clear & i18n guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const state = structuredClone(INITIAL_APP_STATE);
    state.userById[LOCAL_USER_ID] = seedUser();
    setAppState(state, true);
    userRepoMock.getMyUser.mockImplementation(() =>
      Promise.resolve(getAppState().userById[LOCAL_USER_ID] ?? null),
    );
    userRepoMock.setMyUser.mockImplementation((user) => Promise.resolve(user));
    userPrefsRepoMock.getUserPreferences.mockImplementation(() =>
      Promise.resolve(getAppState().userPrefs),
    );
    userPrefsRepoMock.setUserPreferences.mockImplementation(
      async (prefs) => prefs,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("rejects user, preference, and profile-image writes blocked by a local-data clear", async () => {
    const release = await beginLocalDataClear();
    try {
      await expect(setDictationLimitMinutes(10)).rejects.toThrow(
        "Local data is being cleared.",
      );
      await expect(setHandsFreeDelayMs(3000)).rejects.toThrow(
        "Local data is being cleared.",
      );
      await expect(setUserName("Blocked")).rejects.toThrow(
        "Local data is being cleared.",
      );
      await expect(setIncognitoModeEnabled(true)).rejects.toThrow(
        "Local data is being cleared.",
      );
      expect(() => setMyProfileImage("data:image/png;base64,AAAA")).toThrow(
        "Local data is being cleared.",
      );
      expect(getAppState().userById[LOCAL_USER_ID]?.name).toBe("Initial");
      expect(getAppState().local.profileImageByUserId).toEqual({});
      expect(storageRepoMock.setString).not.toHaveBeenCalled();
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      release();
    }
  });

  it("drops stale refreshCurrentUser reads across a local-data clear", async () => {
    let resolveUser!: (user: User | null) => void;
    userRepoMock.getMyUser.mockReturnValueOnce(
      new Promise<User | null>((resolve) => {
        resolveUser = resolve;
      }),
    );
    userPrefsRepoMock.getUserPreferences.mockResolvedValueOnce({
      ...createDefaultPreferences(),
      incognitoModeEnabled: true,
    });

    const pendingRefresh = refreshCurrentUser();
    const release = await beginLocalDataClear();
    try {
      setAppState(structuredClone(INITIAL_APP_STATE), true);
      resolveUser({ ...seedUser(), name: "Stale before wipe" });
      await pendingRefresh;
      expect(getAppState().userById[LOCAL_USER_ID]).toBeUndefined();
      expect(getAppState().userPrefs).toBeNull();
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      release();
    }
  });

  it("formats user action failure snackbars in the active locale", async () => {
    vi.stubGlobal("navigator", { language: "es", languages: ["es"] });
    userRepoMock.setMyUser.mockRejectedValueOnce(new Error("sqlite busy"));

    await expect(setUserName("Nuevo")).rejects.toThrow("sqlite busy");

    expect(getAppState().snackbarMessage).toBe(
      esMessages.failed_to_save_username_please_try_again,
    );
  });
});
