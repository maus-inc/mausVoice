import { ActivationController } from "@maus-inc/desktop-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("ActivationController public contract", () => {
  it("exposes a per-activation release signal without changing callback arguments", async () => {
    const signals: Array<AbortSignal | null> = [];
    const activate = vi.fn(() => {
      signals.push(controller.activationDeactivationSignal);
    });
    const controller = new ActivationController(activate, vi.fn(), true);
    controller.handlePress();
    controller.handleRelease();
    await flush();
    expect(activate).toHaveBeenCalledExactlyOnceWith();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(controller.activationDeactivationSignal).toBeNull();
    controller.dispose();
  });

  it("locks on a short tap and unlocks on the next tap", async () => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate);
    controller.handlePress();
    vi.advanceTimersByTime(100);
    controller.handleRelease();
    expect(controller.isActive).toBe(true);
    expect(controller.isLocked).toBe(true);
    expect(controller.hasHadRelease).toBe(true);
    controller.handlePress();
    vi.advanceTimersByTime(100);
    controller.handleRelease();
    expect(controller.isActive).toBe(false);
    expect(controller.isLocked).toBe(false);
    await flush();
    expect(activate).toHaveBeenCalledOnce();
    expect(deactivate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("ends a long hold and never locks in hold-to-talk mode", async () => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate, true);
    controller.handlePress();
    vi.advanceTimersByTime(50);
    controller.handleRelease();
    expect(controller.isActive).toBe(false);
    expect(controller.isLocked).toBe(false);
    await flush();
    expect(activate).toHaveBeenCalledOnce();
    expect(deactivate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("uses updated callbacks for subsequent state transitions", async () => {
    const originalActivate = vi.fn();
    const originalDeactivate = vi.fn();
    const nextActivate = vi.fn();
    const nextDeactivate = vi.fn();
    const controller = new ActivationController(
      originalActivate,
      originalDeactivate,
    );
    controller.toggle();
    controller.setCallbacks(nextActivate, nextDeactivate);
    controller.toggle();
    controller.toggle();
    await flush();
    expect(originalActivate).toHaveBeenCalledOnce();
    expect(originalDeactivate).not.toHaveBeenCalled();
    expect(nextActivate).toHaveBeenCalledOnce();
    expect(nextDeactivate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("waits for asynchronous activation before deactivating", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new ActivationController(
      async () => {
        events.push("activation-start");
        await gate;
        events.push("activation-end");
      },
      () => {
        events.push("deactivation");
      },
      true,
    );
    controller.handlePress();
    controller.handleRelease();
    await flush();
    expect(events).toEqual(["activation-start"]);
    release();
    await flush();
    expect(events).toEqual([
      "activation-start",
      "activation-end",
      "deactivation",
    ]);
    controller.dispose();
  });

  it("retires queued activation and deactivation after a force reset", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const activate = vi
      .fn()
      .mockReturnValueOnce(waiting)
      .mockResolvedValue(undefined);
    const deactivate = vi.fn();
    const controller = new ActivationController(activate, deactivate, true);
    controller.handlePress();
    await flush();
    controller.handleRelease();
    controller.handlePress();
    controller.forceReset();
    controller.handlePress();
    finish();
    await flush();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(deactivate).not.toHaveBeenCalled();
    controller.handleRelease();
    await flush();
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("continues the callback queue after an activation failure", async () => {
    const deactivate = vi.fn();
    const controller = new ActivationController(
      () => Promise.reject(new Error("failed")),
      deactivate,
      true,
    );
    controller.handlePress();
    controller.handleRelease();
    await flush();
    expect(deactivate).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
