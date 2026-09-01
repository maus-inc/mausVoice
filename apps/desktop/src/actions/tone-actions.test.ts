import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState, produceAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  applyInDictationStyleSwitch,
  applyWritingStyleSelection,
  selectToneByHotkey,
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "./tone.actions";
import { seedManualStyles } from "../../test/helpers/tone-test.utils";

vi.mock("../repos", () => ({
  getToneRepo: () => ({
    listTones: vi.fn(() => Promise.resolve([])),
    upsertTone: vi.fn(),
    deleteTone: vi.fn(),
  }),
  getUserPreferencesRepo: () => ({
    setUserPreferences: vi.fn((prefs: unknown) => Promise.resolve(prefs)),
    getUserPreferences: vi.fn(() => Promise.resolve(null)),
  }),
  getUserRepo: () => ({
    setMyUser: vi.fn((user: unknown) => Promise.resolve(user)),
    getMyUser: vi.fn(() => Promise.resolve(null)),
  }),
}));

vi.mock("./toast.actions", () => ({
  showToast: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock("./user.actions", () => ({
  activateAndSelectTone: vi.fn(),
  setSelectedToneId: (toneId: string) => {
    produceAppState((draft) => {
      const user = draft.userById[LOCAL_USER_ID];
      if (user) {
        user.selectedToneId = toneId;
      }
    });
    return Promise.resolve();
  },
}));

const selectedToneId = () =>
  getAppState().userById[LOCAL_USER_ID]?.selectedToneId ?? null;

describe("Style switching shares one state transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedManualStyles("default");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pill forward, arrow forward, and cycle-hotkey forward all land on the next style", async () => {
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");

    await applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    expect(selectedToneId()).toBe("chat");

    await applyInDictationStyleSwitch({
      channel: "cycle-hotkey",
      direction: 1,
    });
    expect(selectedToneId()).toBe("default");
  });

  it("named cycle/select helpers are aliases of the shared transition", async () => {
    await switchWritingStyleForward();
    expect(selectedToneId()).toBe("email");

    await switchWritingStyleBackward();
    expect(selectedToneId()).toBe("default");

    await selectToneByHotkey("chat");
    expect(selectedToneId()).toBe("chat");
  });
});
