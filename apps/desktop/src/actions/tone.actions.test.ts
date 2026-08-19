import type { Tone } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  applyInDictationStyleSwitch,
  applyWritingStyleSelection,
  selectToneByHotkey,
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "./tone.actions";

const { showToastMock, setSelectedToneIdMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(async () => undefined),
  setSelectedToneIdMock: vi.fn(async (toneId: string) => {
    produceAppState((draft) => {
      const user = draft.userById[LOCAL_USER_ID];
      if (user) {
        user.selectedToneId = toneId;
      }
    });
  }),
}));

vi.mock("../repos", () => ({
  getToneRepo: () => ({
    listTones: vi.fn(async () => []),
    upsertTone: vi.fn(),
    deleteTone: vi.fn(),
  }),
  getUserPreferencesRepo: () => ({
    setUserPreferences: vi.fn(async (prefs: unknown) => prefs),
    getUserPreferences: vi.fn(async () => null),
  }),
  getUserRepo: () => ({
    setMyUser: vi.fn(async (user: unknown) => user),
    getMyUser: vi.fn(async () => null),
  }),
}));

vi.mock("./toast.actions", () => ({
  showToast: showToastMock,
}));

vi.mock("./user.actions", () => ({
  activateAndSelectTone: vi.fn(),
  setSelectedToneId: (toneId: string) => setSelectedToneIdMock(toneId),
}));

const tone = (id: string, name: string): Tone => ({
  id,
  name,
  promptTemplate: "",
  isSystem: true,
  createdAt: 0,
  sortOrder: 0,
});

const seedManualStyles = (selectedToneId: string) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneById = {
    default: tone("default", "Polished"),
    email: tone("email", "Email"),
    chat: tone("chat", "Chat"),
  };
  state.userById[LOCAL_USER_ID] = {
    id: LOCAL_USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Tester",
    onboarded: true,
    playInteractionChime: false,
    hasFinishedTutorial: true,
    wordsThisMonth: 0,
    wordsTotal: 0,
    stylingMode: "manual",
    selectedToneId,
    activeToneIds: ["default", "email", "chat"],
  };
  setAppState(state, true);
};

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
});
