import { describe, expect, it, vi } from "vitest";
import { watchRecordingSession } from "./dictation-session-retirement";

function setup(current: () => boolean) {
  let listener = () => {};
  const unsubscribe = vi.fn();
  const sessionRef: { current: (() => boolean) | null } = { current };
  const abort = vi.fn(async () => {
    sessionRef.current = null;
    listener();
  });
  const stop = watchRecordingSession(
    (check) => {
      listener = check;
      return unsubscribe;
    },
    sessionRef,
    abort,
  );
  return { sessionRef, abort, stop, unsubscribe, notify: () => listener() };
}

describe("watchRecordingSession", () => {
  it("retires one recording after an auth change without reentrant cleanup", async () => {
    let current = true;
    const watcher = setup(() => current);
    watcher.notify();
    expect(watcher.abort).not.toHaveBeenCalled();
    current = false;
    watcher.notify();
    watcher.notify();
    expect(watcher.abort).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(watcher.abort).toHaveBeenCalledOnce();
    watcher.stop();
    expect(watcher.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not abort a successor that starts before cleanup runs", async () => {
    let current = true;
    const watcher = setup(() => current);
    current = false;
    watcher.notify();
    watcher.sessionRef.current = () => true;
    await Promise.resolve();
    expect(watcher.abort).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("cancels queued cleanup on unmount", async () => {
    const watcher = setup(() => false);
    watcher.stop();
    await Promise.resolve();
    expect(watcher.abort).not.toHaveBeenCalled();
  });
});
