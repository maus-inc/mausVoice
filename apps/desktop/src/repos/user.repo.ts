import { Nullable, User } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { nowIso } from "../utils/date.utils";
import { orFalse, orNull, orUndefined, orValue } from "../utils/nullable.utils";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { BaseRepo } from "./base.repo";

const getOnboardedAt = (isOnboarded: boolean): string | null =>
  isOnboarded ? nowIso() : null;

const parseActiveToneIds = (
  activeToneIds: string | null | undefined,
): User["activeToneIds"] => {
  if (!activeToneIds) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(activeToneIds);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
      return null;
    }
    return parsed;
  } catch {
    // Malformed stored JSON must not break loading the user record.
    return null;
  }
};

type LocalUser = {
  id: string;
  name: string;
  bio: string;
  company?: string | null;
  title?: string | null;
  onboarded: boolean;
  preferredMicrophone: string | null;
  preferredLanguage: string | null;
  wordsThisMonth: number;
  wordsThisMonthMonth: string | null;
  wordsTotal: number;
  playInteractionChime?: boolean;
  hasFinishedTutorial?: boolean;
  cohort?: string | null;
  stylingMode?: string | null;
  selectedToneId?: string | null;
  activeToneIds?: string | null;
  streak?: number | null;
  streakRecordedAt?: string | null;
  referralSource?: string | null;
};

const fromLocalUser = (localUser: LocalUser): User => {
  const bio = localUser.bio;
  const isOnboarded = localUser.onboarded;
  const playInteractionChime =
    localUser.playInteractionChime == null
      ? true
      : localUser.playInteractionChime;

  return {
    id: localUser.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    name: localUser.name,
    bio: bio || null,
    company: orNull(localUser.company),
    title: orNull(localUser.title),
    onboarded: isOnboarded,
    onboardedAt: getOnboardedAt(isOnboarded),
    timezone: null,
    preferredMicrophone: orNull(localUser.preferredMicrophone),
    preferredLanguage: orNull(localUser.preferredLanguage),
    wordsThisMonth: orValue(localUser.wordsThisMonth, 0),
    wordsThisMonthMonth: orNull(localUser.wordsThisMonthMonth),
    wordsTotal: orValue(localUser.wordsTotal, 0),
    playInteractionChime,
    hasFinishedTutorial: orFalse(localUser.hasFinishedTutorial),
    cohort: orNull(localUser.cohort),
    stylingMode: (localUser.stylingMode as User["stylingMode"]) ?? null,
    selectedToneId: orNull(localUser.selectedToneId),
    activeToneIds: parseActiveToneIds(localUser.activeToneIds),
    streak: orUndefined(localUser.streak),
    streakRecordedAt: orUndefined(localUser.streakRecordedAt),
    referralSource: orUndefined(localUser.referralSource),
  };
};

const toLocalUser = (user: User): LocalUser => ({
  id: LOCAL_USER_ID,
  name: user.name,
  bio: user.bio ?? "",
  company: user.company ?? null,
  title: user.title ?? null,
  onboarded: user.onboarded,
  preferredMicrophone: user.preferredMicrophone ?? null,
  preferredLanguage: user.preferredLanguage ?? null,
  wordsThisMonth: user.wordsThisMonth,
  wordsThisMonthMonth: user.wordsThisMonthMonth ?? null,
  wordsTotal: user.wordsTotal,
  playInteractionChime: user.playInteractionChime,
  hasFinishedTutorial: user.hasFinishedTutorial,
  cohort: user.cohort ?? null,
  stylingMode: user.stylingMode ?? null,
  selectedToneId: user.selectedToneId ?? null,
  activeToneIds: user.activeToneIds ? JSON.stringify(user.activeToneIds) : null,
  streak: user.streak ?? null,
  streakRecordedAt: user.streakRecordedAt ?? null,
  referralSource: user.referralSource ?? null,
});

export abstract class BaseUserRepo extends BaseRepo {
  abstract setMyUser(user: User): Promise<User>;
  abstract getMyUser(): Promise<Nullable<User>>;
}

export class LocalUserRepo extends BaseUserRepo {
  async setMyUser(user: User): Promise<User> {
    const stored = await invoke<LocalUser>("user_set_one", {
      user: toLocalUser(user),
    });

    return fromLocalUser(stored);
  }

  async getMyUser(): Promise<Nullable<User>> {
    const user = await invoke<Nullable<LocalUser>>("user_get_one");

    return user ? fromLocalUser(user) : null;
  }
}
