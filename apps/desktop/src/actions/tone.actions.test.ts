import type { Tone, User } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";

const { invokeMock, setSelectedToneIdMock, showToastMock, loggerMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(async () => undefined),
    setSelectedToneIdMock: vi.fn(async (toneId: string) => {
      produceAppState((draft) => {
        const user = draft.userById[LOCAL_USER_ID];
        if (user) {
          user.selectedToneId = toneId;
        }
      });
    }),
    showToastMock: vi.fn(async () => undefined),
    loggerMock: {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
      stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
        fn(),
      ),
    },
  }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("./user.actions", () => ({
  setSelectedToneId: setSelectedToneIdMock,
  activateAndSelectTone: vi.fn(),
}));

vi.mock("./toast.actions", () => ({ showToast: showToastMock }));

vi.mock("./app.actions", () => ({
  showErrorSnackbar: vi.fn(),
  showSnackbar: vi.fn(),
}));

vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (
      descriptor: { defaultMessage: string },
      values?: { toneName?: string },
    ) =>
      descriptor.defaultMessage.replace("{toneName}", values?.toneName ?? ""),
  }),
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

vi.mock("../repos", () => ({
  getToneRepo: () => ({}),
  getUserPreferencesRepo: () => ({}),
}));

const {
  cycleWritingStyle,
  getPillStyleInfo,
  handlePillStyleSwitch,
  selectToneByHotkey,
  switchWritingStyleBackward,
  switchWritingStyleForward,
} = await import("./tone.actions");

const tone = (id: string, name: string): Tone =>
  ({
    id,
    name,
    promptTemplate: "",
    isSystem: true,
    createdAt: 0,
    sortOrder: 0,
  }) as Tone;

const seedManualStyles = (selectedToneId: string) => {
  setAppState({
    ...structuredClone(INITIAL_APP_STATE),
    userById: {
      [LOCAL_USER_ID]: {
        id: LOCAL_USER_ID,
        stylingMode: "manual",
        selectedToneId,
        activeToneIds: ["default", "email", "chat"],
      } as User,
    },
    toneById: {
      default: tone("default", "Polished"),
      email: tone("email", "Email"),
      chat: tone("chat", "Chat"),
    },
  });
};

describe("pill style switch / shared writing-style transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    seedManualStyles("default");
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("handlePillStyleSwitch forward calls the shared cycle and applies the next style", async () => {
    await handlePillStyleSwitch("forward");

    expect(setSelectedToneIdMock).toHaveBeenCalledTimes(1);
    expect(setSelectedToneIdMock).toHaveBeenCalledWith("email");
    expect(getAppState().userById[LOCAL_USER_ID]?.selectedToneId).toBe("email");
    expect(getPillStyleInfo().name).toBe("Email");
    expect(invokeMock).toHaveBeenCalledWith("notify_pill_style_info", {
      count: 3,
      name: "Email",
    });
  });

  it("handlePillStyleSwitch backward calls the same transition in reverse", async () => {
    await handlePillStyleSwitch("backward");

    expect(setSelectedToneIdMock).toHaveBeenCalledWith("chat");
    expect(getPillStyleInfo()).toEqual({ count: 3, name: "Chat" });
  });

  it("accepts mixed-case direction from a malformed pill payload", async () => {
    await handlePillStyleSwitch("  Forward  ");
    expect(setSelectedToneIdMock).toHaveBeenCalledWith("email");
  });

  it("ignores an unknown direction without mutating the applied style", async () => {
    await handlePillStyleSwitch("sideways");

    expect(setSelectedToneIdMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getAppState().userById[LOCAL_USER_ID]?.selectedToneId).toBe(
      "default",
    );
    expect(loggerMock.warning).toHaveBeenCalled();
  });

  it("hotkey wrappers and the pill handler share cycleWritingStyle", async () => {
    await switchWritingStyleForward();
    expect(setSelectedToneIdMock).toHaveBeenLastCalledWith("email");

    await switchWritingStyleBackward();
    expect(setSelectedToneIdMock).toHaveBeenLastCalledWith("default");

    await cycleWritingStyle(1);
    expect(setSelectedToneIdMock).toHaveBeenLastCalledWith("email");
  });

  it("queues rapid chevron clicks so each step sees the previous write", async () => {
    await Promise.all([
      handlePillStyleSwitch("forward"),
      handlePillStyleSwitch("forward"),
    ]);

    expect(setSelectedToneIdMock).toHaveBeenCalledTimes(2);
    expect(setSelectedToneIdMock.mock.calls.map((call) => call[0])).toEqual([
      "email",
      "chat",
    ]);
    expect(getAppState().userById[LOCAL_USER_ID]?.selectedToneId).toBe("chat");
    expect(getPillStyleInfo().name).toBe("Chat");
  });

  it("toasts instead of no-oping when only one style is active", async () => {
    produceAppState((draft) => {
      const user = draft.userById[LOCAL_USER_ID];
      if (user) {
        user.activeToneIds = ["default"];
      }
    });

    await handlePillStyleSwitch("forward");

    expect(setSelectedToneIdMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toastType: "info",
        message: expect.stringContaining("Polished"),
      }),
    );
  });

  it("hides the pill selector outside manual styling so it cannot show a stale name", () => {
    produceAppState((draft) => {
      const user = draft.userById[LOCAL_USER_ID];
      if (user) {
        user.stylingMode = "app";
      }
    });

    expect(getPillStyleInfo()).toEqual({ count: 0, name: "-" });
  });

  it("selectToneByHotkey uses the same applied-style write and refreshes the pill", async () => {
    await selectToneByHotkey("chat");

    expect(setSelectedToneIdMock).toHaveBeenCalledWith("chat");
    expect(invokeMock).toHaveBeenCalledWith("notify_pill_style_info", {
      count: 3,
      name: "Chat",
    });
  });
});
