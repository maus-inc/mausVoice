import { getCurrentWindow } from "@tauri-apps/api/window";
import { getLogger } from "./log.utils";

const LOCAL_DATA_WRITE_LEASE = Symbol("local-data-write-lease");
const LOCAL_DATA_CLEAR_ERROR = "Local data is being cleared.";
const MAIN_WINDOW_WRITE_ERROR =
  "Local data writes are only allowed from the main window.";
export const LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY =
  "mausvoice:local-data-clear-pending";

type Release = () => void;

type LeaseState = {
  activeReferences: number;
  active: boolean;
};

export type LocalDataWriteLease = {
  readonly [LOCAL_DATA_WRITE_LEASE]: true;
};

export type LocalDataWriteRelease = Release & {
  readonly lease: LocalDataWriteLease;
};

const leaseStates = new WeakMap<LocalDataWriteLease, LeaseState>();

const getBrowserStorage = (): Storage | null => {
  try {
    if (typeof window !== "undefined") return window.localStorage;
    // Tests run in Node with an explicit Storage stub. Production always has a
    // WebView window; the main-window identity check still rejects all writes
    // in any non-browser process.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** True when a previous clear still needs to be retried or completed. */
const readPendingLocalDataClearMarker = (): boolean | null => {
  const storage = getBrowserStorage();
  if (!storage) return null;

  try {
    const marker = storage.getItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    return typeof marker === "string" && marker.length > 0;
  } catch {
    return null;
  }
};

export const hasPendingLocalDataClear = (): boolean =>
  readPendingLocalDataClearMarker() === true;

let activeWrites = 0;
let activeClears = 0;
let clearRequestGeneration = 0;
let clearRequested = readPendingLocalDataClearMarker() !== false;
let writesDrained: Promise<void> | null = null;
let resolveWritesDrained: (() => void) | null = null;
let synchronousLease: LocalDataWriteLease | null = null;

/** True from the start of a clear request until every clear owner releases it. */
export const isLocalDataClearRequested = (): boolean => clearRequested;

/** A monotonic token that invalidates remote work started before any clear. */
export const getLocalDataClearGeneration = (): number => clearRequestGeneration;

type LocalDataClearRequestedListener = () => void;
const localDataClearRequestedListeners =
  new Set<LocalDataClearRequestedListener>();

const notifyLocalDataClearRequestedListener = (
  listener: LocalDataClearRequestedListener,
): void => {
  try {
    listener();
  } catch (error) {
    getLogger().warning("Local-data clear listener failed", error);
  }
};

const notifyLocalDataClearRequested = (): void => {
  for (const listener of Array.from(localDataClearRequestedListeners)) {
    notifyLocalDataClearRequestedListener(listener);
  }
};

/** Subscribe to the clear transition for side effects that need cancellation. */
export const subscribeToLocalDataClearRequested = (
  listener: LocalDataClearRequestedListener,
): (() => void) => {
  localDataClearRequestedListeners.add(listener);
  if (clearRequested) notifyLocalDataClearRequestedListener(listener);
  return () => {
    localDataClearRequestedListeners.delete(listener);
  };
};

export const isMainLocalDataWindow = (): boolean => {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
};

const isLocalDataWriteWindow = (): boolean => {
  try {
    const label = getCurrentWindow().label;
    // The browser preview uses an in-memory repository. Allow its UI to exercise
    // ordinary repository writes, but keep destructive clear operations main-only.
    return (
      label === "main" ||
      (import.meta.env.MODE === "preview" && label === "preview")
    );
  } catch {
    return false;
  }
};

const blockedWriteError = (): Error =>
  new Error(
    isLocalDataWriteWindow() ? LOCAL_DATA_CLEAR_ERROR : MAIN_WINDOW_WRITE_ERROR,
  );

export const assertLocalDataWriteLease = (lease: LocalDataWriteLease): void => {
  if (!leaseStates.get(lease)?.active) {
    throw new Error("Local data write lease is no longer active.");
  }
};

const releaseReference = (lease: LocalDataWriteLease): void => {
  const state = leaseStates.get(lease);
  if (!state?.active) return;

  state.activeReferences -= 1;
  if (state.activeReferences > 0) return;

  state.active = false;
  leaseStates.delete(lease);
  activeWrites -= 1;
  if (activeWrites === 0) resolveWritesDrained?.();
};

const retainLease = (lease: LocalDataWriteLease): Release => {
  assertLocalDataWriteLease(lease);
  const state = leaseStates.get(lease);
  if (!state) throw new Error("Local data write lease is no longer active.");

  state.activeReferences += 1;
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    releaseReference(lease);
  };
};

export const beginLocalDataWrite = (): LocalDataWriteRelease | null => {
  if (!isLocalDataWriteWindow() || clearRequested) return null;

  const lease = Object.freeze({
    [LOCAL_DATA_WRITE_LEASE]: true as const,
  });
  leaseStates.set(lease, { activeReferences: 1, active: true });
  activeWrites += 1;

  let released = false;
  const release = (() => {
    if (released) return;
    released = true;
    releaseReference(lease);
  }) as LocalDataWriteRelease;
  Object.defineProperty(release, "lease", { value: lease });
  return release;
};

export const withLocalDataWrite = async <T>(
  operation: (lease: LocalDataWriteLease) => Promise<T>,
  existingLease?: LocalDataWriteLease,
): Promise<T> => {
  let lease: LocalDataWriteLease;
  let releaseWrite: Release;

  if (existingLease) {
    lease = existingLease;
    releaseWrite = retainLease(existingLease);
  } else {
    const write = beginLocalDataWrite();
    if (!write) throw blockedWriteError();
    lease = write.lease;
    releaseWrite = write;
  }

  try {
    return await operation(lease);
  } finally {
    releaseWrite();
  }
};

export const withSynchronousLocalDataWriteLease = <T>(
  lease: LocalDataWriteLease,
  operation: () => T,
): T => {
  assertLocalDataWriteLease(lease);
  const previousLease = synchronousLease;
  synchronousLease = lease;
  try {
    return operation();
  } finally {
    synchronousLease = previousLease;
  }
};

export const getSynchronousLocalDataWriteLease =
  (): LocalDataWriteLease | null => synchronousLease;

export const withLocalDataWriteSync = <T>(
  operation: (lease: LocalDataWriteLease) => T,
  existingLease?: LocalDataWriteLease,
): T | undefined => {
  let lease: LocalDataWriteLease;
  let releaseWrite: Release;

  if (existingLease) {
    lease = existingLease;
    releaseWrite = retainLease(existingLease);
  } else {
    const write = beginLocalDataWrite();
    if (!write) return undefined;
    lease = write.lease;
    releaseWrite = write;
  }

  try {
    return withSynchronousLocalDataWriteLease(lease, () => operation(lease));
  } finally {
    releaseWrite();
  }
};

export const beginLocalDataClear = async (): Promise<Release> => {
  if (!isMainLocalDataWindow()) {
    throw new Error("Only the main window can clear local data.");
  }

  const storage = getBrowserStorage();
  if (!storage) {
    throw new Error(
      "Browser storage is unavailable, so local data cannot be cleared safely.",
    );
  }
  try {
    // Keep a durable latch so a WebView reload after a partial clear cannot
    // silently reopen browser-side writes before the user retries the clear.
    if (storage.getItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY) === null) {
      storage.setItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY, "1");
    }
  } catch (error) {
    throw new Error(
      "Unable to protect the local-data clear from interruption.",
      { cause: error },
    );
  }

  clearRequested = true;
  activeClears += 1;
  clearRequestGeneration += 1;
  notifyLocalDataClearRequested();

  if (activeWrites > 0) {
    writesDrained ??= new Promise<void>((resolve) => {
      resolveWritesDrained = resolve;
    });
    await writesDrained;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeClears -= 1;
    if (activeClears === 0 && readPendingLocalDataClearMarker() === false) {
      clearRequested = false;
      writesDrained = null;
      resolveWritesDrained = null;
    }
  };
};
