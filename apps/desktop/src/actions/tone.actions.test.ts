import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState, produceAppState, setAppState } from "../store";
import { INITIAL_APP_STATE } from "../state/app.state";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  applyInDictationStyleSwitch,
  applyWritingStyleSelection,
  selectToneByHotkey,
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "./tone.actions";
import { seedManualStyles } from "../../test/helpers/tone-test.utils";

const { setSelectedToneIdMock } = vi.hoisted(() => ({
  setSelectedToneIdMock: vi.fn((toneId: string) => {
    produceAppState((draft) => {
      const user = draft.userById[LOCAL_USER_ID];
      if (user) {
        user.selectedToneId = toneId;
      }
    });
    return Promise.resolve();
  }),
}));

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
  showToast: vi.fn(() => Promise.resolve()),
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
  setSelectedToneId: (toneId: string) => setSelectedToneIdMock(toneId),
}));

const selectedToneId = () =>
  getAppState().userById[LOCAL_USER_ID]?.selectedToneId ?? null;

describe("writing style switch channels share one state transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedManualStyles("default");
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("applyWritingStyleSelection writes selectedToneId", async () => {
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");
    expect(setSelectedToneIdMock).toHaveBeenCalledWith("email");
  });

  it("pill forward, arrow forward, and cycle-hotkey forward all land on the next style", async () => {
    await applyInDictationStyleSwitch({ channel: "pill", direction: 1 });
    expect(selectedToneId()).toBe("email");

    await applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    expect(selectedToneId()).toBe("chat");

    await applyInDictationStyleSwitch({
      channel: "cycle-hotkey",
      direction: 1,
    });
    expect(selectedToneId()).toBe("default");
  });

  it("a style-select hotkey writes the same selectedToneId slot", async () => {
    await applyInDictationStyleSwitch({ channel: "hotkey", toneId: "chat" });
    expect(selectedToneId()).toBe("chat");
  });

  it("named cycle/select helpers are aliases of the shared transition", async () => {
    await switchWritingStyleForward();
    expect(selectedToneId()).toBe("email");

    await switchWritingStyleBackward();
    expect(selectedToneId()).toBe("default");

    await selectToneByHotkey("chat");
    expect(selectedToneId()).toBe("chat");
  });

  it("applies the in-memory selection before the persist promise settles", () => {
    setSelectedToneIdMock.mockReturnValue(new Promise(() => undefined));
    const pending = applyInDictationStyleSwitch({
      channel: "hotkey",
      toneId: "chat",
    });
    expect(selectedToneId()).toBe("chat");
    void pending;
  });

  it("skips persist when there is no user so in-memory and disk stay aligned", async () => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    await applyInDictationStyleSwitch({ channel: "hotkey", toneId: "chat" });
    expect(setSelectedToneIdMock).not.toHaveBeenCalled();
    expect(selectedToneId()).toBeNull();
  });

  it("restores the previous selection when persistence fails", async () => {
    setSelectedToneIdMock.mockRejectedValueOnce(new Error("sqlite down"));
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");
  });
});
