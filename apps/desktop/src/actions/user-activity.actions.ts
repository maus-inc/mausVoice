import {
  type LocalDataWriteLease,
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { notifyDailyActivityChanged } from "../utils/daily-activity.events";
import dayjs from "dayjs";
import { showErrorSnackbar } from "./app.actions";
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

import {
  enqueuePrefsMutation,
  enqueueUserMutation,
  markPreferencesReconciled,
  markUserReconciled,
  updateUser,
} from "./user-actions-core";

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
  const intl = getIntl();

  await updateUser(
    (u) => {
      u.streak = newStreak;
      u.streakRecordedAt = today;
    },
    intl.formatMessage({
      defaultMessage: "Unable to update streak. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to update streak. Please try again.",
    }),
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

// The transcription-storage owner holds the local-data lease while this queued
// profile mutation runs. Keep the lease there so it also covers audio and history.
export const recordUsageWords = (
  eventId: string,
  localDate: string,
  wordCount: number,
  lease?: LocalDataWriteLease,
): Promise<void> =>
  enqueueUserMutation(async () => {
    if (!Number.isSafeInteger(wordCount) || wordCount <= 0) {
      return;
    }

    try {
      await withLocalDataWrite(async (writeLease) => {
        const user = await getUserRepo().recordUsageWords(
          eventId,
          localDate,
          wordCount,
          writeLease,
        );
        produceAppState((draft) => {
          setCurrentUser(draft, user);
        }, writeLease);
        notifyDailyActivityChanged();
      }, lease);
    } catch (error) {
      getLogger().error(`Failed to record usage metrics: ${error}`);
      showErrorSnackbar(
        getIntl().formatMessage({
          defaultMessage: "Failed to update usage metrics. Please try again.",
        }),
      );
      throw error;
    }
  });

// Runs across both user and preference mutation chains so a refresh never reads
// a row that a queued save is halfway through writing. Never call this from
// inside a queued user or preference task.
const refreshUserAndPreferences = async (generation: number): Promise<void> => {
  if (
    isLocalDataClearRequested() ||
    generation !== getLocalDataClearGeneration()
  ) {
    return;
  }
  try {
    getLogger().verbose("Refreshing current user and preferences");
    const [userResult, preferencesResult] = await Promise.allSettled([
      getUserRepo().getMyUser(),
      getUserPreferencesRepo().getUserPreferences(),
    ]);

    if (
      isLocalDataClearRequested() ||
      generation !== getLocalDataClearGeneration()
    ) {
      return;
    }

    const user = userResult.status === "fulfilled" ? userResult.value : null;
    const hasPreferencesResult = preferencesResult.status === "fulfilled";
    const preferences = hasPreferencesResult ? preferencesResult.value : null;
    if (userResult.status === "rejected") {
      getLogger().warning(`Failed to refresh user: ${userResult.reason}`);
    } else if (user) {
      markUserReconciled();
    }
    if (preferencesResult.status === "rejected") {
      getLogger().warning(
        `Failed to refresh user preferences: ${preferencesResult.reason}`,
      );
    } else {
      markPreferencesReconciled();
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

export const refreshCurrentUser = (): Promise<void> => {
  const generation = getLocalDataClearGeneration();
  return enqueueUserMutation(() =>
    enqueuePrefsMutation(() => refreshUserAndPreferences(generation)),
  );
};
