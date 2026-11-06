import {
  commands,
  type NativeSetupResult,
} from "@maus-inc/desktop-native-apis";
import { useSyncExternalStore } from "react";

let running = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const isRunning = () => running;
const setRunning = (value: boolean) => {
  running = value;
  for (const listener of listeners) listener();
};

export const useInputPermissionSetupRunning = (): boolean =>
  useSyncExternalStore(subscribe, isRunning, () => false);

/** The native prompt must have one owner even when the settings page remounts. */
export const runInputPermissionSetup =
  async (): Promise<NativeSetupResult | null> => {
    if (running) return null;
    setRunning(true);
    try {
      return await commands.runNativeSetup();
    } finally {
      setRunning(false);
    }
  };
