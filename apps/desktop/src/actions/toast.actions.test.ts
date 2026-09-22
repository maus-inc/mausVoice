import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

const { dismissToast, showPersistentToast } = await import("./toast.actions");

const payloadTypes = () =>
  invoke.mock.calls.map(
    (call) => JSON.parse((call[1] as { payload: string }).payload).type,
  );

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("native toast IPC ordering", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("delivers a slow show before a later dismiss", async () => {
    const delivered: string[] = [];
    const showArrived = deferred<void>();
    const releaseShow = deferred<void>();
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { type } = JSON.parse((args as { payload: string }).payload);
      if (type === "toast") {
        showArrived.resolve();
        await releaseShow.promise;
      }
      delivered.push(type);
    });

    const showing = showPersistentToast("working", 120_000);
    const dismissing = dismissToast();
    await showArrived.promise;
    releaseShow.resolve();
    await Promise.all([showing, dismissing]);

    // Without serialization the dismiss lands first and the loading toast
    // stays on screen for its full duration.
    expect(delivered).toEqual(["toast", "dismiss_toast"]);
  });

  it("keeps serving later toasts after one fails", async () => {
    invoke
      .mockRejectedValueOnce(new Error("pill offline"))
      .mockResolvedValueOnce(undefined);

    await expect(showPersistentToast("first", 1000)).rejects.toThrow(
      "pill offline",
    );
    await expect(dismissToast()).resolves.toBeUndefined();
    expect(payloadTypes()).toEqual(["toast", "dismiss_toast"]);
  });
});

describe("queue isolation across sequential callers", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("does not replay or drop commands after an earlier rejection", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(dismissToast()).rejects.toThrow("boom");

    invoke.mockResolvedValue(undefined);
    await showPersistentToast("a", 1000);
    await dismissToast();
    await showPersistentToast("b", 1000);

    expect(payloadTypes()).toEqual([
      "dismiss_toast",
      "toast",
      "dismiss_toast",
      "toast",
    ]);
  });
});
