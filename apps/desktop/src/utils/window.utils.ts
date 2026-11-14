import { Nullable } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { withLocalDataWriteSync } from "./local-data-write-gate";

const SURFACE_WINDOW_FLAG_KEY = "mausvoice:surface-main-window-on-launch";

let surfaceWindowPromise: Promise<boolean> | null = null;

const getLocalStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    console.error("Unable to access localStorage", error);
    return null;
  }
};

export const surfaceMainWindow = async (): Promise<boolean> => {
  if (!surfaceWindowPromise) {
    surfaceWindowPromise = invoke<void>("surface_main_window")
      .then(() => true)
      .catch((error) => {
        console.error(
          "Failed to surface main window via native command",
          error,
        );
        return false;
      })
      .finally(() => {
        surfaceWindowPromise = null;
      });
  }

  return surfaceWindowPromise;
};

/**
 * Fire-and-forget surfacing for synchronous listener bodies that must not
 * wait on the IPC. `surfaceMainWindow` returns false and logs native failures;
 * the catch here keeps the intentionally detached promise explicit for the
 * floating-promise linters, in one place instead of at every call site.
 */
export const surfaceMainWindowDetached = (): void => {
  surfaceMainWindow().catch(() => {
    // surfaceMainWindow reports its own errors
  });
};

export const setTrayTitle = async (title: Nullable<string>): Promise<void> => {
  try {
    await invoke<void>("set_tray_title", { title });
  } catch (error) {
    console.error("Failed to set tray title", error);
  }
};

export const markSurfaceWindowForNextLaunch = (): void => {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  withLocalDataWriteSync(() => {
    try {
      storage.setItem(SURFACE_WINDOW_FLAG_KEY, "1");
    } catch (error) {
      console.error("Failed to mark surface window flag", error);
    }
  });
};

export const consumeSurfaceWindowFlag = (): boolean => {
  const storage = getLocalStorage();
  if (!storage) {
    return false;
  }

  return (
    withLocalDataWriteSync(() => {
      try {
        const value = storage.getItem(SURFACE_WINDOW_FLAG_KEY);
        if (value != null) {
          storage.removeItem(SURFACE_WINDOW_FLAG_KEY);
        }
        return value === "1";
      } catch (error) {
        console.error("Failed to read surface window flag", error);
        return false;
      }
    }) ?? false
  );
};
