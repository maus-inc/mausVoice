import { FirebaseApp } from "firebase/app";
import { Auth, getAuth } from "firebase/auth";

let _auth: Auth | null = null;

export const getEffectiveAuth = (): Auth => {
  if (!_auth) {
    throw new Error("Auth has not been initialized. Call createAuth first.");
  }

  return _auth;
};

export const createEffectiveAuth = (app: FirebaseApp): Auth => {
  if (_auth) {
    throw new Error("Auth has already been initialized.");
  }

  _auth = getAuth(app);

  return getEffectiveAuth();
};
