// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import {
  beginLocalDataClear,
  getLocalDataClearGeneration,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";

const { firebaseSet, firebaseRemove, refreshStatus } = vi.hoisted(() => ({
  firebaseSet: vi.fn<(...args: unknown[]) => Promise<void>>(),
  firebaseRemove: vi.fn<(...args: unknown[]) => Promise<void>>(),
  refreshStatus:
    vi.fn<() => Promise<{ deviceId: string; deviceName: string }>>(),
}));

vi.mock("firebase/database", () => ({
  getDatabase: vi.fn(() => ({})),
  onDisconnect: vi.fn(() => ({ remove: vi.fn(async () => undefined) })),
  onValue: vi.fn(() => () => undefined),
  ref: vi.fn((_database: unknown, path: string) => ({ path })),
  remove: firebaseRemove,
  set: firebaseSet,
  update: vi.fn(async () => undefined),
}));

vi.mock("../../actions/remote-receiver.actions", () => ({
  refreshRemoteReceiverStatus: refreshStatus,
}));
vi.mock("../../actions/remote-transcript.actions", () => ({
  handleRemoteFinalTextReceived: vi.fn(async () => undefined),
}));

import { SessionSideEffects } from "./SessionSideEffects";

ensureUiHarness();

describe("SessionSideEffects local-clear coordination", () => {
  let container: HTMLDivElement;
  let root: Root;
  let finishFirebaseSet: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    firebaseSet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFirebaseSet = resolve;
        }),
    );
    firebaseRemove.mockResolvedValue();
    refreshStatus.mockResolvedValue({
      deviceId: "desktop-1",
      deviceName: "Test desktop",
    });

    const state = structuredClone(INITIAL_APP_STATE);
    state.initialized = true;
    state.auth = {
      uid: "user-1",
      email: "test@example.com",
      displayName: "Test User",
      providers: ["test"],
    };
    setAppState(state, true);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    finishFirebaseSet = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    finishFirebaseSet?.();
    finishFirebaseSet = undefined;
  });

  it("does not let an offline session publish block clear and queues its removal", async () => {
    const initialGeneration = getLocalDataClearGeneration();
    await act(async () => {
      root.render(<SessionSideEffects />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firebaseSet).toHaveBeenCalledTimes(1);

    let releaseClear: (() => void) | undefined;
    const clearPromise = beginLocalDataClear().then((release) => {
      releaseClear = release;
      return release;
    });
    const clearCompletedBeforeAck = await Promise.race([
      clearPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 50);
      }),
    ]);

    try {
      expect(clearCompletedBeforeAck).toBe(true);
      expect(getLocalDataClearGeneration()).toBe(initialGeneration + 1);
      expect(firebaseRemove).toHaveBeenCalledWith({
        path: "session/user-1/desktop-1",
      });
    } finally {
      finishFirebaseSet?.();
      if (!releaseClear) releaseClear = await clearPromise;
      window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }
  });
});
