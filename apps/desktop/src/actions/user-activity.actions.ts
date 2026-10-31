import dayjs from "dayjs";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { sendPillFireworks, sendPillFlame } from "../utils/overlay.utils";
import {
  getMyUser,
  setCurrentUser,
  setUserPreferences,
} from "../utils/user.utils";

import { enqueueUserMutation, updateUser } from "./user-actions-core";

const getCurrentUsageMonth = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
};

const getCurrentDateString = (): string => dayjs().format("YYYY-MM-DD");

const getYesterdayDateString = (): string =>
  dayjs().subtract(1, "day").format("YYYY-MM-DD");

type StreakInfo = ["flame" | "fireworks", string] | null;

const getStreakInfo = (streak: number): StreakInfo => {
  const intl = getIntl();

  if (streak === 1) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "Let the streak begin! 🔥" }),
    ];
  }

  if (streak === 2) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "2 days in a row! ✌️" }),
    ];
  }

  if (streak === 3) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "3 days strong! 💪" }),
    ];
  }

  if (streak === 5) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "High five! 5 days! 🖐️" }),
    ];
  }

  if (streak === 7) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "A full week! 🎉" }),
    ];
  }

  if (streak === 10) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "Double digits! 🔥" }),
    ];
  }

  if (streak === 30) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "One month! Unstoppable! 🚀" }),
    ];
  }

  if (streak === 50) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "50 days! Legend! 🏆" }),
    ];
  }

  if (streak === 100) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "100 days! 💯" }),
    ];
  }

  if (streak % 100 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} days! Incredible! 🌟" },
        { streak },
      ),
    ];
  }

  if (streak % 10 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} day streak! 🎉" },
        { streak },
      ),
    ];
  }

  return null;
};

export const recordStreak = async (): Promise<void> => {
  const state = getAppState();
  const user = getMyUser(state);
  if (!user) {
    return;
  }

  const today = getCurrentDateString();
  if (user.streakRecordedAt === today) {
    return;
  }

  const yesterday = getYesterdayDateString();
  const isConsecutive = user.streakRecordedAt === yesterday;
  const newStreak = isConsecutive ? (user.streak ?? 0) + 1 : 1;

  await updateUser(
    (u) => {
      u.streak = newStreak;
      u.streakRecordedAt = today;
    },
    "Unable to update streak. User not found.",
    "Failed to update streak. Please try again.",
  );

  const info = getStreakInfo(newStreak);
  const isEnabled = !getAppState().local.disablePillRewards;
  if (info && isEnabled) {
    const [mode, message] = info;
    if (mode === "fireworks") {
      sendPillFireworks(message);
    } else {
      sendPillFlame(message);
    }
  }
};

export const addWordsToCurrentUser = async (
  wordCount: number,
): Promise<void> => {
  if (wordCount <= 0) {
    return;
  }

  await updateUser(
    (user) => {
      const currentMonth = getCurrentUsageMonth();
      if (user.wordsThisMonthMonth !== currentMonth) {
        user.wordsThisMonth = 0;
        user.wordsThisMonthMonth = currentMonth;
      }

      user.wordsThisMonth += wordCount;
      user.wordsTotal += wordCount;
    },
    "Unable to update usage. User not found.",
    "Failed to update usage metrics. Please try again.",
  );
};

// Runs on the same chain as `updateUser` so a refresh never reads a row that a
// queued save is halfway through writing. It must never be called from inside
// a queued task: the chain is already occupied there and the call would wait on
// itself forever. The failure path in `updateUser` therefore re-reads the row
// inline rather than calling this.
const refreshUserAndPreferences = async (): Promise<void> => {
  try {
    getLogger().verbose("Refreshing current user and preferences");
    const [userResult, preferencesResult] = await Promise.allSettled([
      getUserRepo().getMyUser(),
      getUserPreferencesRepo().getUserPreferences(),
    ]);

    const user = userResult.status === "fulfilled" ? userResult.value : null;
    const hasPreferencesResult = preferencesResult.status === "fulfilled";
    const preferences = hasPreferencesResult ? preferencesResult.value : null;
    if (userResult.status === "rejected") {
      getLogger().warning(`Failed to refresh user: ${userResult.reason}`);
    }
    if (preferencesResult.status === "rejected") {
      getLogger().warning(
        `Failed to refresh user preferences: ${preferencesResult.reason}`,
      );
    }

    produceAppState((draft) => {
      if (user) {
        setCurrentUser(draft, user);
      }

      if (!hasPreferencesResult) {
        return;
      }

      if (preferences) {
        setUserPreferences(draft, preferences);
      } else {
        draft.userPrefs = null;
      }
    });
    getLogger().verbose(
      `User refreshed (hasUser=${!!user}, hasPrefs=${hasPreferencesResult ? !!preferences : "unavailable"})`,
    );
  } catch (error) {
    getLogger().error(`Failed to refresh user: ${error}`);
  }
};

export const refreshCurrentUser = (): Promise<void> =>
  enqueueUserMutation(refreshUserAndPreferences);
