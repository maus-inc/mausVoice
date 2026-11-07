import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getByLabel: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: mocks.getByLabel },
}));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../actions/toast.actions", () => ({
  runToast: vi.fn(),
  showToast: mocks.showToast,
}));
vi.mock("./log.utils", () => ({
  getLogger: () => ({ warning: vi.fn(), error: vi.fn() }),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
let listeners: Map<string, Array<(event: { payload: unknown }) => void>>;
const emit = (name: string, payload: unknown) =>
  listeners.get(name)?.forEach((fn) => fn({ payload }));
const requestId = (index = 0): string =>
  mocks.invoke.mock.calls.filter(([name]) => name === "composer_register_text")[
    index
  ][1].requestId;

describe("composer setup lifetime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    listeners = new Map();
    mocks.listen.mockImplementation(
      async (name: string, callback: (event: { payload: unknown }) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), callback]);
        return vi.fn();
      },
    );
    mocks.invoke.mockImplementation(async (name: string) =>
      name === "floating_window_create" ? { id: "composer" } : undefined,
    );
    mocks.getByLabel.mockResolvedValue(null);
    mocks.showToast.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("destroys a late-created window without replacing the next owner", async () => {
    const creation = deferred<{ id: string }>();
    let creations = 0;
    mocks.invoke.mockImplementation((name: string) => {
      if (name === "floating_window_create") {
        creations++;
        return creations === 1
          ? creation.promise
          : Promise.resolve({ id: "second" });
      }
      return Promise.resolve();
    });
    const { reviewTextInComposer } = await import("./composer.utils");
    const first = reviewTextInComposer("first");
    await flush();
    emit("composer-result", {
      requestId: requestId(),
      accepted: true,
      text: "edited",
    });
    await expect(first).resolves.toBe("edited");
    const second = reviewTextInComposer("second");
    await flush();
    creation.resolve({ id: "late-first" });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("floating_window_destroy", {
      id: "late-first",
    });
    await expect(reviewTextInComposer("third")).resolves.toBeNull();
    expect(creations).toBe(2);
    expect(mocks.getByLabel).toHaveBeenLastCalledWith("second");
    emit("composer-result", {
      requestId: requestId(1),
      accepted: false,
      text: "",
    });
    await second;
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("does not install a close listener after a settled window lookup", async () => {
    const onCloseRequested = vi.fn().mockResolvedValue(vi.fn());
    const lookup = deferred<{ onCloseRequested: typeof onCloseRequested }>();
    mocks.getByLabel.mockReturnValue(lookup.promise);
    const { reviewTextInComposer } = await import("./composer.utils");
    const pending = reviewTextInComposer("draft");
    await flush();
    emit("composer-result", {
      requestId: requestId(),
      accepted: true,
      text: "edited",
    });
    await pending;
    lookup.resolve({ onCloseRequested });
    await flush();
    expect(onCloseRequested).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("disposes a close listener that finishes registering after settlement", async () => {
    const unlisten = vi.fn();
    const registration = deferred<() => void>();
    mocks.getByLabel.mockResolvedValue({
      onCloseRequested: vi.fn(() => registration.promise),
    });
    const { reviewTextInComposer } = await import("./composer.utils");
    const pending = reviewTextInComposer("draft");
    await flush();
    emit("composer-result", {
      requestId: requestId(),
      accepted: false,
      text: "",
    });
    await pending;
    registration.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves readiness received while native lookup is still pending", async () => {
    const lookup = deferred<null>();
    mocks.getByLabel.mockReturnValue(lookup.promise);
    const { reviewTextInComposer } = await import("./composer.utils");
    const pending = reviewTextInComposer("draft");
    await flush();
    emit("composer-ready", { requestId: requestId() });
    lookup.resolve(null);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.showToast).not.toHaveBeenCalled();
    emit("composer-result", {
      requestId: requestId(),
      accepted: true,
      text: "edited",
    });
    await expect(pending).resolves.toBe("edited");
    expect(vi.getTimerCount()).toBe(0);
  });
});
