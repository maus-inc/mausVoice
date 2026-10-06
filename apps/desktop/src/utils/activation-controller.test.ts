import { ActivationController } from "@maus-inc/desktop-utils";
import { describe, expect, it, vi } from "vitest";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("ActivationController async transitions", () => {
  it("latches one stop during activation and ignores more toggles until idle", async () => {
    const start = deferred();
    const activate = vi.fn(() => start.promise);
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate);

    controller.toggle();
    controller.toggle();
    controller.toggle();
    await flushMicrotasks();

    expect(activate).toHaveBeenCalledOnce();
    expect(deactivate).not.toHaveBeenCalled();
    expect(controller.isActive).toBe(false);

    controller.toggle();
    controller.toggle();
    start.resolve();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());

    expect(deactivate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(false);

    controller.toggle();
    await flushMicrotasks();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("does not queue another activation while deactivation is pending", async () => {
    const stop = deferred();
    const activate = vi.fn();
    const deactivate = vi.fn(() => stop.promise);
    const controller = new ActivationController(activate, deactivate);

    controller.toggle();
    await flushMicrotasks();
    expect(controller.isActive).toBe(true);

    controller.toggle();
    controller.toggle();
    controller.toggle();
    await flushMicrotasks();
    expect(deactivate).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(false);

    stop.resolve();
    await flushMicrotasks();
    expect(activate).toHaveBeenCalledOnce();

    controller.toggle();
    await flushMicrotasks();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("turns a hold-to-talk release during startup into one later stop", async () => {
    const start = deferred();
    const activate = vi.fn(() => start.promise);
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate, true);

    controller.handlePress();
    controller.handleRelease();
    controller.handlePress();
    controller.handleRelease();
    await flushMicrotasks();

    expect(activate).toHaveBeenCalledOnce();
    expect(deactivate).not.toHaveBeenCalled();

    start.resolve();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());

    expect(deactivate).toHaveBeenCalledOnce();
    expect(controller.isActive).toBe(false);
  });

  it("does not run stale startup completion after force reset", async () => {
    const start = deferred();
    const activate = vi.fn(() => start.promise);
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate);

    controller.toggle();
    await flushMicrotasks();
    controller.forceReset();
    start.resolve();
    await flushMicrotasks();

    expect(deactivate).not.toHaveBeenCalled();
    expect(controller.isActive).toBe(false);
    controller.toggle();
    await flushMicrotasks();
    expect(activate).toHaveBeenCalledTimes(2);
  });
});
