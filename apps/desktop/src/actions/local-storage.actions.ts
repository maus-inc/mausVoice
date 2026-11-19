import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { withLocalDataWriteSync } from "../utils/local-data-write-gate";
import { produceAppState } from "../store";
import { getLocalStorage } from "../utils/local-storage.utils";

export const setLocalStorageValue = <T>(
  key: string,
  value: T,
  lease?: LocalDataWriteLease,
): void => {
  const storage = getLocalStorage();
  withLocalDataWriteSync((activeLease) => {
    if (storage) {
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.error(`Unable to set localStorage key "${key}":`, error);
      }
    }
    produceAppState((draft) => {
      draft.localStorageCache[key] = value;
    }, activeLease);
  }, lease);
};

export const clearLocalStorageValue = (
  key: string,
  lease?: LocalDataWriteLease,
): void => {
  const storage = getLocalStorage();
  withLocalDataWriteSync((activeLease) => {
    if (storage) {
      try {
        storage.removeItem(key);
      } catch (error) {
        console.error(`Unable to remove localStorage key "${key}":`, error);
      }
    }
    produceAppState((draft) => {
      delete draft.localStorageCache[key];
    }, activeLease);
  }, lease);
};
