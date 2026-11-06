import dayjs from "dayjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (user: User) => user),
  flame: vi.fn(),
  fireworks: vi.fn(),
}));
vi.mock("../repos", () => ({ getUserRepo: () => ({ setMyUser: mocks.save }) }));
vi.mock("../utils/overlay.utils", () => ({
  sendPillFlame: mocks.flame,
  sendPillFireworks: mocks.fireworks,
}));
vi.mock("../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n")>()),
  getIntl: () => ({
    formatMessage: (
      descriptor: { defaultMessage: string },
      values?: Record<string, number>,
    ) =>
      Object.entries(values ?? {}).reduce(
        (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
        descriptor.defaultMessage,
      ),
  }),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
import { addWordsToCurrentUser, recordStreak } from "./user.actions";

const seedStreak = (previousStreak: number, recordedAt: string) => {
  const state = structuredClone(INITIAL_APP_STATE);
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
    streak: previousStreak,
    streakRecordedAt: recordedAt,
  } as User;
  setAppState(state, true);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 15, 12));
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
afterEach(() => {
  vi.useRealTimers();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("streak rewards", () => {
  it.each([
    [1, "flame", "Let the streak begin! 🔥"],
    [2, "flame", "2 days in a row! ✌️"],
    [3, "flame", "3 days strong! 💪"],
    [5, "flame", "High five! 5 days! 🖐️"],
    [7, "fireworks", "A full week! 🎉"],
    [10, "fireworks", "Double digits! 🔥"],
    [30, "fireworks", "One month! Unstoppable! 🚀"],
    [50, "fireworks", "50 days! Legend! 🏆"],
    [100, "fireworks", "100 days! 💯"],
    [200, "fireworks", "200 days! Incredible! 🌟"],
    [20, "fireworks", "20 day streak! 🎉"],
  ])("saves and celebrates day %i", async (streak, mode, message) => {
    seedStreak(streak - 1, dayjs().subtract(1, "day").format("YYYY-MM-DD"));
    await recordStreak();
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(streak);
    const shown = mode === "flame" ? mocks.flame : mocks.fireworks;
    const other = mode === "flame" ? mocks.fireworks : mocks.flame;
    expect(shown).toHaveBeenCalledExactlyOnceWith(message);
    expect(other).not.toHaveBeenCalled();
  });

  it("saves non-milestones without a celebration", async () => {
    seedStreak(3, dayjs().subtract(1, "day").format("YYYY-MM-DD"));
    await recordStreak();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(4);
    expect(mocks.flame).not.toHaveBeenCalled();
    expect(mocks.fireworks).not.toHaveBeenCalled();
  });

  it("restarts a broken streak and does not act when the user is absent", async () => {
    await recordStreak();
    expect(mocks.save).not.toHaveBeenCalled();

    seedStreak(90, dayjs().subtract(2, "day").format("YYYY-MM-DD"));
    await recordStreak();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(1);
    expect(mocks.flame).toHaveBeenCalledExactlyOnceWith(
      "Let the streak begin! 🔥",
    );
    expect(mocks.fireworks).not.toHaveBeenCalled();
  });

  it("records and celebrates only once when stops overlap", async () => {
    seedStreak(1, dayjs().subtract(1, "day").format("YYYY-MM-DD"));
    await Promise.all([recordStreak(), recordStreak()]);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(2);
    expect(mocks.flame).toHaveBeenCalledOnce();
  });

  it("does not apply a queued streak to a later authentication session", async () => {
    seedStreak(1, dayjs().subtract(1, "day").format("YYYY-MM-DD"));
    let finish!: (value: User) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<User>((resolve) => {
          finish = resolve;
        }),
    );
    const first = addWordsToCurrentUser(1);
    await Promise.resolve();
    expect(mocks.save).toHaveBeenCalledOnce();
    const streak = recordStreak();
    const outcomes = Promise.allSettled([first, streak]);
    setAppState({ authSessionNonce: getAppState().authSessionNonce + 1 });
    finish(getAppState().userById[LOCAL_USER_ID]);
    expect((await outcomes).map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(1);
    expect(mocks.flame).not.toHaveBeenCalled();
  });

  it("suppresses rewards when disabled and does not record twice in a day", async () => {
    seedStreak(1, dayjs().subtract(1, "day").format("YYYY-MM-DD"));
    setAppState({
      local: { ...getAppState().local, disablePillRewards: true },
    });
    await recordStreak();
    await recordStreak();
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(getAppState().userById[LOCAL_USER_ID].streak).toBe(2);
    expect(mocks.flame).not.toHaveBeenCalled();
    expect(mocks.fireworks).not.toHaveBeenCalled();
  });
});
