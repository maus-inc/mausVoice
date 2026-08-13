import { AuthUser } from "../types/auth.types";
import {
  PERSONAL_USER_DISPLAY_NAME,
  PERSONAL_USER_EMAIL,
  PERSONAL_USER_ID,
} from "../utils/personal-use.utils";
import { BaseRepo } from "./base.repo";

export abstract class BaseAuthRepo extends BaseRepo {
  abstract signUpWithEmail(email: string, password: string): Promise<void>;
  abstract sendEmailVerificationForCurrentUser(): Promise<void>;
  abstract signOut(): Promise<void>;
  abstract signInWithEmail(email: string, password: string): Promise<void>;
  abstract sendPasswordResetRequest(email: string): Promise<void>;
  abstract signInWithGoogleTokens(
    idToken: string,
    accessToken: string,
  ): Promise<void>;
  abstract signInWithSsoTokens(payload: {
    token: string;
    refreshToken: string;
    authId: string;
    email: string;
  }): Promise<void>;
  abstract getCurrentUser(): AuthUser | null;
  abstract deleteMyAccount(): Promise<void>;
  abstract refreshTokens(): Promise<void>;
  abstract onAuthStateChanged(
    callback: (user: AuthUser | null) => void,
    onError: (error: Error) => void,
  ): () => void;
}

const personalAuthUser: AuthUser = {
  uid: PERSONAL_USER_ID,
  email: PERSONAL_USER_EMAIL,
  displayName: PERSONAL_USER_DISPLAY_NAME,
  providers: ["personal"],
};

/**
 * The only auth repo in use: the personal/local profile. The cloud account
 * (Firebase email/Google) and enterprise SSO auth repos were removed in 0.1.6
 * along with their backends.
 */
export class PersonalAuthRepo extends BaseAuthRepo {
  async signUpWithEmail(): Promise<void> {
    // noop
  }

  async sendEmailVerificationForCurrentUser(): Promise<void> {
    // noop
  }

  async signOut(): Promise<void> {
    // noop
  }

  async signInWithEmail(): Promise<void> {
    // noop
  }

  async sendPasswordResetRequest(): Promise<void> {
    // noop
  }

  async signInWithGoogleTokens(): Promise<void> {
    // noop
  }

  async signInWithSsoTokens(): Promise<void> {
    // noop
  }

  getCurrentUser(): AuthUser {
    return personalAuthUser;
  }

  async deleteMyAccount(): Promise<void> {
    // noop
  }

  async refreshTokens(): Promise<void> {
    // noop
  }

  onAuthStateChanged(
    callback: (user: AuthUser | null) => void,
    _onError: (error: Error) => void,
  ): () => void {
    callback(personalAuthUser);
    return () => undefined;
  }
}
