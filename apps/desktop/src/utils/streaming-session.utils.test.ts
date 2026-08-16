import { describe, expect, it, vi } from "vitest";
import { createStreamingFinalize } from "./streaming-session.utils";

type BuilderArgs = {
  timeoutMs?: number;
  canSend?: boolean;
  text?: string;
  sendTermination?: boolean;
};

const buildFinalize = (args: BuilderArgs = {}) => {
  const timeoutMs = args.timeoutMs ?? 50;
  const canSend = args.canSend ?? true;
  const sendTermination = args.sendTermination ?? false;
  let text = args.text ?? "transcript";
  let finalized = false;
  let cleanedUp = false;
  const termination = vi.fn();

  const finalize = createStreamingFinalize({
    logPrefix: "test",
    timeoutMs,
    getText: () => text,
    getIsFinalized: () => finalized,
    setIsFinalized: (value) => {
      finalized = value;
    },
    flushPendingSamples: vi.fn(),
    logTotalChunks: vi.fn(),
    canSend: () => canSend,
    getWsState: () => 1,
    sendTermination: sendTermination ? termination : undefined,
    cleanup: () => {
      cleanedUp = true;
    },
  });

  return {
    finalize,
    termination,
    isCleanedUp: () => cleanedUp,
    setText: (next: string) => {
      text = next;
    },
  };
};

describe("createStreamingFinalize", () => {
  it("resolves via the bounded timeout when no early completion arrives", async () => {
    const { finalize, isCleanedUp } = buildFinalize({ timeoutMs: 20 });

    await expect(finalize.finalize()).resolves.toBe("transcript");
    expect(isCleanedUp()).toBe(true);
    expect(finalize.hasPendingFinalize()).toBe(false);
  });

  it("returns the existing transcript immediately when already finalized", async () => {
    const { finalize } = buildFinalize();

    await expect(finalize.finalize()).resolves.toBe("transcript");
  });

  it("completeFinalize resolves the pending finalize early and only once", async () => {
    const { finalize, isCleanedUp } = buildFinalize({ timeoutMs: 5000 });

    const promise = finalize.finalize();
    expect(finalize.hasPendingFinalize()).toBe(true);

    finalize.completeFinalize();

    await expect(promise).resolves.toBe("transcript");
    expect(isCleanedUp()).toBe(true);
    expect(finalize.hasPendingFinalize()).toBe(false);

    // second call is a safe no-op, must not throw or double-resolve
    expect(() => finalize.completeFinalize()).not.toThrow();
  });

  it("completeFinalize is a safe no-op before finalize is called", () => {
    const { finalize } = buildFinalize();

    expect(() => finalize.completeFinalize()).not.toThrow();
    expect(finalize.hasPendingFinalize()).toBe(false);
  });

  it("resolves immediately with cleanup when canSend is false", async () => {
    const { finalize, isCleanedUp } = buildFinalize({ canSend: false });

    await expect(finalize.finalize()).resolves.toBe("transcript");
    expect(isCleanedUp()).toBe(true);
    expect(finalize.hasPendingFinalize()).toBe(false);
  });
});
