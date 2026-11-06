import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcknowledgedStreamFinalization } from "./acknowledged-stream-finalization";

afterEach(() => vi.useRealTimers());

describe("acknowledged stream finalization", () => {
  const options = () => ({
    prepare: vi.fn((): string | null => null),
    sendTermination: vi.fn(),
    cleanup: vi.fn(),
    getText: () => "complete transcript",
    loggerPrefix: "test",
    timeoutMs: 100,
  });

  it("waits for the acknowledgement and detaches before a synchronous close", async () => {
    const config = options();
    const finalization = createAcknowledgedStreamFinalization(config);
    config.cleanup.mockImplementation(() => finalization.fail("late close"));
    const pending = finalization.finalize();
    expect(finalization.finalize()).toBe(pending);
    expect(finalization.isPending()).toBe(true);
    finalization.complete();
    finalization.complete();
    await expect(pending).resolves.toBe("complete transcript");
    expect(config.sendTermination).toHaveBeenCalledOnce();
    expect(config.cleanup).toHaveBeenCalledOnce();
  });

  it("memoizes even a reentrant finalize and never arms a timer after synchronous acknowledgement", async () => {
    vi.useFakeTimers();
    const config = options();
    const finalization = createAcknowledgedStreamFinalization(config);
    let reentrant: Promise<string> | undefined;
    config.sendTermination.mockImplementation(() => {
      reentrant = finalization.finalize();
      finalization.complete();
    });
    const pending = finalization.finalize();
    expect(reentrant).toBe(pending);
    await expect(pending).resolves.toBe("complete transcript");
    expect(config.sendTermination).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails and cleans up on a flush failure without sending termination", async () => {
    const config = options();
    config.prepare.mockReturnValue("lost audio");
    const finalization = createAcknowledgedStreamFinalization(config);
    const pending = finalization.finalize();
    await expect(pending).rejects.toThrow("lost audio");
    expect(finalization.finalize()).toBe(pending);
    expect(config.sendTermination).not.toHaveBeenCalled();
    expect(config.cleanup).toHaveBeenCalledOnce();
  });

  it("fails and closes after the acknowledgement timeout", async () => {
    vi.useFakeTimers();
    const config = options();
    const finalization = createAcknowledgedStreamFinalization(config);
    const pending = finalization.finalize();
    const assertion = expect(pending).rejects.toThrow("finalization timed out");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(config.cleanup).toHaveBeenCalledOnce();
    expect(finalization.isPending()).toBe(false);
  });

  it("rejects a send exception without leaking its contents", async () => {
    const config = options();
    config.sendTermination.mockImplementation(() => {
      throw new Error("secret provider payload");
    });
    const pending = createAcknowledgedStreamFinalization(config).finalize();
    await expect(pending).rejects.toThrow("could not be finalized");
    expect(config.cleanup).toHaveBeenCalledOnce();
  });
});
