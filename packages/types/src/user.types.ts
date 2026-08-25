import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import type { Nullable, Replace, StylingMode } from "./common.types";
import { StylingModeZod } from "./common.types";

export type DatabaseUser = {
  id: string;
  createdAt: FiremixTimestamp;
  updatedAt: FiremixTimestamp;
  name: string;
  bio?: Nullable<string>;
  company?: Nullable<string>;
  title?: Nullable<string>;
  onboarded: boolean;
  onboardedAt?: Nullable<FiremixTimestamp>;
  timezone?: Nullable<string>;
  preferredLanguage?: Nullable<string>;
  preferredMicrophone?: Nullable<string>;
  playInteractionChime: boolean;
  /**
   * Thock playback gain in 0..1, applied on the warm audio path AND the
   * fallback path. Defaults to 0.35 (a touch below the previous hard-coded
   * 0.45). Clamped to [0.05, 0.5] server-side so the user can never blow
   * out the sink or make the thock inaudible.
   */
  interactionFeedbackVolume?: Nullable<number>;
  hasFinishedTutorial: boolean;
  wordsThisMonth: number;
  wordsThisMonthMonth?: Nullable<string>;
  wordsTotal: number;
  hasMigratedPreferredMicrophone?: Nullable<boolean>;
  cohort?: Nullable<string>;
  shouldShowUpgradeDialog?: Nullable<boolean>;
  stylingMode?: Nullable<StylingMode>;
  selectedToneId?: Nullable<string>;
  activeToneIds?: Nullable<string[]>;
  streak?: Nullable<number>;
  streakRecordedAt?: Nullable<string>;
  referralSource?: Nullable<string>;
};

export type User = Replace<DatabaseUser, FiremixTimestamp, string>;

export type UserWithAuth = User & {
  email: string;
  isAdmin: boolean;
};

export const UserZod = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    bio: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    onboarded: z.boolean(),
    onboardedAt: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    preferredLanguage: z.string().nullable().optional(),
    preferredMicrophone: z.string().nullable().optional(),
    playInteractionChime: z.boolean(),
    interactionFeedbackVolume: z.number().min(0).max(1).nullable().optional(),
    hasFinishedTutorial: z.boolean(),
    wordsThisMonth: z.number(),
    wordsThisMonthMonth: z.string().nullable().optional(),
    wordsTotal: z.number(),
    hasMigratedPreferredMicrophone: z.boolean().nullable().optional(),
    cohort: z.string().nullable().optional(),
    shouldShowUpgradeDialog: z.boolean().nullable().optional(),
    stylingMode: StylingModeZod.nullable().optional(),
    selectedToneId: z.string().nullable().optional(),
    activeToneIds: z.array(z.string()).nullable().optional(),
    streak: z.number().nullable().optional(),
    streakRecordedAt: z.string().nullable().optional(),
    referralSource: z.string().nullable().optional(),
  })
  .strict() satisfies z.ZodType<User>;
