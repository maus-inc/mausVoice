import { useAppStore } from "../store";
import {
  getIsOnboarded,
  getMyPreferredMicrophone,
  getMyProfileImage,
  getMyUser,
} from "../utils/user.utils";

export const useMyUser = () => useAppStore(getMyUser);

export const useIsOnboarded = () => useAppStore(getIsOnboarded);

export const useMyPreferredMicrophone = () =>
  useAppStore(getMyPreferredMicrophone);

/** The current user's custom profile photo, if they have set one. */
export const useMyProfileImage = () => useAppStore(getMyProfileImage);
